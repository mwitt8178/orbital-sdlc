/**
 * admin/hub-admin.ts — Hub-mode admin endpoints.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * These endpoints are ONLY active when ORBITAL_MODE=hub. In local mode,
 * registerHubAdminRoutes() is a no-op: routes are never registered.
 *
 * Endpoints:
 *   GET  /admin/health          — version, uptime, db status, ws connections, tenant count
 *   GET  /admin/installs        — list known_installs (owner-auth required)
 *   POST /admin/installs/:id/revoke — revoke install (owner-auth, logged)
 *   GET  /admin/audit-tail      — recent audit events (?since=<ISO8601>, owner-auth)
 *   POST /admin/backup          — trigger pg_dump backup (owner-auth)
 *   GET  /admin/backup/status   — list recent backups (owner-auth)
 *
 * Auth:
 *   All routes check the `x-orbital-owner-token` header against
 *   ORBITAL_OWNER_TOKEN env var (or keychain entry `hub.owner_token`).
 *   In development mode with no token configured, routes are open (loud warn).
 *
 * multi-tenant-isolation:
 *   These are hub-admin endpoints — they operate across ALL tenants by design.
 *   No tenant_id scoping here: the owner has cross-tenant visibility.
 *
 * Coordination note:
 *   round7-02-local-hub-split owns trpc/routers/*.ts and ws/hub.ts.
 *   This file is standalone Fastify routes, not tRPC — no collision.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db, sql } from '../db/client.js'
import { logger } from '../config/logger.js'
import { loadEnv } from '../config/env.js'
import { verifyRequest } from '../hub/auth/middleware.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnownInstall {
  installId: string
  displayName: string | null
  role: 'owner' | 'member'
  publicKey: string
  joinedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export interface AuditEvent {
  eventId: string
  eventType: string
  actorType: string
  actorId: string
  tenantId: string
  occurredAt: string
  payload: Record<string, unknown>
}

export interface BackupStatus {
  filename: string
  path: string
  sizeBytes: number
  createdAt: string
}

export interface HubHealthPayload {
  mode: 'hub'
  version: string
  uptime: number
  timestamp: string
  db: { status: 'ok' | 'down'; detail?: string }
  tenantCount: number
}

// ---------------------------------------------------------------------------
// Owner authentication via signed envelope (Round 7-03)
//
// Replaces the placeholder x-orbital-owner-token check. The owner is now
// determined by:
//   1. The signed envelope on the request authenticates the install_id.
//   2. known_installs.role for that install_id must be 'owner'.
//
// Dev-mode escape hatch: when NODE_ENV=development AND no envelope headers
// are present, requests are allowed (loud one-shot warning). This keeps the
// existing dev workflow alive during the transition.
//
// The legacy x-orbital-owner-token header is no longer accepted.
// ---------------------------------------------------------------------------

let _openModeWarningEmitted = false

/**
 * Extract the raw HTTP body bytes off a Fastify request. Fastify parses JSON
 * bodies into req.body; we need the raw bytes for sha256(body) verification.
 * The Fastify pre-parsing hook (registered in src/index.ts) copies the
 * original buffer onto req.rawBody.
 */
function getRawBodyBytes(req: FastifyRequest): Uint8Array {
  const raw = (req as { rawBody?: unknown }).rawBody
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (typeof raw === 'string') return new TextEncoder().encode(raw)
  // Fall back: serialize parsed body (best-effort; matches what a JSON-only
  // client would have signed if it didn't preserve raw bytes).
  if (req.body !== undefined && req.body !== null) {
    try {
      return new TextEncoder().encode(JSON.stringify(req.body))
    } catch {
      return new Uint8Array(0)
    }
  }
  return new Uint8Array(0)
}

/**
 * Middleware: require owner role on the authenticated install.
 *
 * - 401 AUTH_HEADER_MISSING / AUTH_SIG_INVALID / etc. on bad/missing envelope.
 * - 403 FORBIDDEN if envelope valid but role !== 'owner'.
 * - In NODE_ENV=development with NO envelope present: allow (with warn).
 *
 * Returns true if authorized; sends the error reply and returns false otherwise.
 */
async function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const env = loadEnv()

  const installIdHdr = req.headers['x-orbital-install-id']
  const sigHdr = req.headers['x-orbital-sig']
  const sigBodyHdr = req.headers['x-orbital-sig-body']

  const hasEnvelope = installIdHdr !== undefined && sigHdr !== undefined && sigBodyHdr !== undefined

  // Dev-mode escape: no envelope present → allow with one-shot warning.
  if (!hasEnvelope) {
    if (env.NODE_ENV === 'development') {
      if (!_openModeWarningEmitted) {
        logger.warn(
          'hub-admin: OPEN DEV MODE — no signed envelope present. ' +
            'In production, requests without X-Orbital-Sig headers are rejected.',
        )
        _openModeWarningEmitted = true
      }
      return true
    }
    void reply.status(401).send({
      error: {
        code: 'AUTH_HEADER_MISSING',
        message:
          'Signed envelope required (X-Orbital-Install-Id / X-Orbital-Sig / X-Orbital-Sig-Body)',
      },
    })
    return false
  }

  // Verify envelope
  const result = await verifyRequest({
    headers: req.headers,
    requestBodyBytes: getRawBodyBytes(req),
  })

  if (!result.ok) {
    void reply.status(401).send({
      error: { code: result.code, message: result.detail },
    })
    return false
  }

  if (result.identity.role !== 'owner') {
    void reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: `Owner role required (install ${result.identity.installId} is ${result.identity.role})`,
      },
    })
    return false
  }

  return true
}

/** Test helper — reset open mode warning flag */
export function _resetOwnerModeWarning(): void {
  _openModeWarningEmitted = false
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Count distinct active tenants (best-effort).
 *
 * Round 7-03 will add a `known_installs` table and a `tenant_id` column
 * to events. Until then, we count distinct aggregate_ids in events as a
 * proxy, or fall back to the known_installs table if it exists.
 */
async function countTenants(): Promise<number> {
  // Try known_installs first (available after Round 7-03 migration)
  try {
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(DISTINCT role)::int AS c FROM known_installs WHERE revoked_at IS NULL
    `
    return rows[0]?.c ?? 0
  } catch {
    // Fall through to events count
  }

  try {
    // Estimate from actor JSONB tenant_id field
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(DISTINCT actor->>'tenant_id')::int AS c
      FROM audit.events
      WHERE actor->>'tenant_id' IS NOT NULL
    `
    return rows[0]?.c ?? 0
  } catch {
    return 0
  }
}

/** Fetch known_installs from DB. Falls back gracefully if table doesn't exist. */
async function fetchKnownInstalls(): Promise<KnownInstall[]> {
  try {
    // known_installs is created by Round 7-03 migration. If it doesn't exist
    // yet (pre-migration), return empty array — admin UI shows "no installs".
    const rows = await sql<{
      install_id: string
      display_name: string | null
      role: string
      public_key: string
      joined_at: Date
      last_seen_at: Date | null
      revoked_at: Date | null
    }[]>`
      SELECT install_id, display_name, role, public_key, joined_at, last_seen_at, revoked_at
      FROM known_installs
      ORDER BY joined_at ASC
    `
    return rows.map((r) => ({
      installId: r.install_id,
      displayName: r.display_name,
      role: r.role as 'owner' | 'member',
      publicKey: r.public_key,
      joinedAt: r.joined_at.toISOString(),
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      revokedAt: r.revoked_at?.toISOString() ?? null,
    }))
  } catch (err) {
    logger.warn({ err }, 'hub-admin: known_installs table not available (pre-migration)')
    return []
  }
}

/** Revoke an install by setting revoked_at. Logs audit event. */
async function revokeInstall(installId: string): Promise<void> {
  await sql`
    UPDATE known_installs
    SET revoked_at = NOW()
    WHERE install_id = ${installId}
      AND revoked_at IS NULL
  `

  // Best-effort audit event
  try {
    const env = loadEnv()
    await sql`
      INSERT INTO audit.events (
        event_id, aggregate_id, aggregate_type, event_type,
        payload, actor, trace_id, occurred_at, schema_version
      ) VALUES (
        gen_random_uuid(),
        ${installId}::uuid,
        'known_install',
        'hub.install_revoked',
        ${JSON.stringify({ install_id: installId })}::jsonb,
        ${JSON.stringify({ type: 'system', id: 'hub-admin', tenant_id: env.ORBITAL_HUB_TENANT_ID })}::jsonb,
        'hub-admin-revoke',
        NOW(),
        1
      )
    `
  } catch {
    // Audit failure must not block the revoke response
  }
}

interface AuditRow {
  event_id: string
  event_type: string
  aggregate_type: string
  aggregate_id: string
  actor: Record<string, unknown>
  occurred_at: string
  payload: Record<string, unknown>
}

/** Fetch recent audit events since a given timestamp. */
async function fetchAuditTail(since: string | null, limit: number): Promise<AuditEvent[]> {
  // Build query conditionally — postgres.js doesn't support nested sql`` in conditionals
  // NOTE: tenant_id is not yet in the events schema (added by Round 7-03 migration).
  // We derive actorId/actorType from the actor JSONB column for display.
  let rows: AuditRow[]

  if (since) {
    rows = await sql<AuditRow[]>`
      SELECT event_id, event_type, aggregate_type, aggregate_id, actor, occurred_at, payload
      FROM audit.events
      WHERE occurred_at > ${new Date(since)}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `
  } else {
    rows = await sql<AuditRow[]>`
      SELECT event_id, event_type, aggregate_type, aggregate_id, actor, occurred_at, payload
      FROM audit.events
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `
  }

  return rows.map((r) => {
    const actor = r.actor ?? {}
    // actor JSONB shape: { type: string, id: string, ... }
    const actorType = String(actor['type'] ?? actor['kind'] ?? 'system')
    const actorId = String(actor['id'] ?? actor['install_id'] ?? actor['persona_id'] ?? 'unknown')

    return {
      eventId: r.event_id,
      eventType: r.event_type,
      actorType,
      actorId,
      // tenant_id column added by Round 7-03 migration; use aggregate_id as proxy for now
      tenantId: String(actor['tenant_id'] ?? r.aggregate_id ?? 'unknown'),
      occurredAt: typeof r.occurred_at === 'string'
        ? r.occurred_at
        : (r.occurred_at as unknown as Date).toISOString(),
      payload: r.payload,
    }
  })
}

/** Trigger a backup using hub-backup.sh in a child process. */
async function triggerBackup(): Promise<{ filename: string; sizeBytes: number }> {
  const scriptDir = path.join(process.cwd(), 'scripts')
  const backupScript = path.join(scriptDir, 'hub-backup.sh')

  // Check script exists
  await fs.access(backupScript)

  const { stdout } = await execFileAsync('bash', [backupScript], {
    timeout: 300_000, // 5 min max
    env: { ...process.env },
  })

  // Parse last JSON line for filename + size
  const lines = stdout.trim().split('\n').filter((l) => l.startsWith('{'))
  const lastLine = lines[lines.length - 1]
  if (!lastLine) throw new Error('backup script produced no JSON output')

  const parsed = JSON.parse(lastLine) as { event?: string; filename?: string; size_bytes?: number }
  if (parsed.event !== 'backup_complete') {
    throw new Error(`Unexpected final event from backup script: ${parsed.event ?? 'unknown'}`)
  }

  return {
    filename: parsed.filename ?? 'unknown',
    sizeBytes: parsed.size_bytes ?? 0,
  }
}

/** List backup files from the local backups/ directory. */
async function listBackups(): Promise<BackupStatus[]> {
  const backupDir = process.env['BACKUP_DIR'] ?? path.join(process.cwd(), 'backups')
  let entries: string[] = []

  try {
    const files = await fs.readdir(backupDir)
    entries = files.filter((f) => f.match(/orbital-hub-backup-.+\.sql\.gz\.enc$/))
  } catch {
    return []
  }

  const statPromises = entries.map(async (filename) => {
    const filePath = path.join(backupDir, filename)
    try {
      const stat = await fs.stat(filePath)
      return {
        filename,
        path: filePath,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
      } satisfies BackupStatus
    } catch {
      return null
    }
  })

  const results = await Promise.all(statPromises)
  return results.filter((r): r is BackupStatus => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register hub-mode admin HTTP routes on the Fastify instance.
 *
 * NO-OP in local mode. Call this from index.ts after buildApp() in hub mode only.
 */
export function registerHubAdminRoutes(app: FastifyInstance): void {
  const env = loadEnv()
  if (env.ORBITAL_MODE !== 'hub') {
    logger.debug('hub-admin: ORBITAL_MODE is not hub — skipping admin route registration')
    return
  }

  logger.info('hub-admin: registering hub admin routes (ORBITAL_MODE=hub)')

  // ---- GET /admin/health ----
  app.get('/admin/health', async (_req, reply): Promise<void> => {
    let dbStatus: HubHealthPayload['db'] = { status: 'ok' }
    try {
      await sql`SELECT 1`
    } catch (err) {
      dbStatus = { status: 'down', detail: (err as Error).message }
    }

    const tenantCount = await countTenants()

    const payload: HubHealthPayload = {
      mode: 'hub',
      version: process.env['npm_package_version'] ?? 'unknown',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      db: dbStatus,
      tenantCount,
    }

    void reply.status(200).send(payload)
  })

  // ---- GET /admin/installs ----
  app.get('/admin/installs', async (req, reply): Promise<void> => {
    const authorized = await requireOwner(req, reply)
    if (!authorized) return

    const installs = await fetchKnownInstalls()
    void reply.status(200).send({ installs })
  })

  // ---- POST /admin/installs/:id/revoke ----
  app.post<{ Params: { id: string } }>(
    '/admin/installs/:id/revoke',
    async (req, reply): Promise<void> => {
      const authorized = await requireOwner(req, reply)
      if (!authorized) return

      const { id } = req.params
      if (!id || id.length === 0) {
        void reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Install ID is required' },
        })
        return
      }

      try {
        await revokeInstall(id)
        void reply.status(200).send({ installId: id, revokedAt: new Date().toISOString() })
      } catch (err) {
        logger.error({ err, installId: id }, 'hub-admin: revokeInstall failed')
        void reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke install' },
        })
      }
    },
  )

  // ---- GET /admin/audit-tail ----
  app.get<{ Querystring: { since?: string; limit?: string } }>(
    '/admin/audit-tail',
    async (req, reply): Promise<void> => {
      const authorized = await requireOwner(req, reply)
      if (!authorized) return

      const { since, limit: limitStr } = req.query
      const limit = Math.min(parseInt(limitStr ?? '100', 10), 500)

      try {
        const events = await fetchAuditTail(since ?? null, limit)
        void reply.status(200).send({ events, count: events.length })
      } catch (err) {
        const errMsg = (err as Error).message ?? 'unknown'
        logger.error({ err, errMsg }, 'hub-admin: fetchAuditTail failed')
        void reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: `Failed to fetch audit events: ${errMsg}` },
        })
      }
    },
  )

  // ---- POST /admin/backup ----
  app.post('/admin/backup', async (req, reply): Promise<void> => {
    const authorized = await requireOwner(req, reply)
    if (!authorized) return

    try {
      const result = await triggerBackup()
      void reply.status(202).send({
        status: 'triggered',
        ...result,
        triggeredAt: new Date().toISOString(),
      })
    } catch (err) {
      logger.error({ err }, 'hub-admin: triggerBackup failed')
      void reply.status(500).send({
        error: {
          code: 'BACKUP_ERROR',
          message: (err as Error).message ?? 'Backup failed',
        },
      })
    }
  })

  // ---- GET /admin/backup/status ----
  app.get('/admin/backup/status', async (req, reply): Promise<void> => {
    const authorized = await requireOwner(req, reply)
    if (!authorized) return

    const backups = await listBackups()
    void reply.status(200).send({ backups, count: backups.length })
  })
}
