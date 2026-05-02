/**
 * trpc/routers/admin.ts — Admin/operations tRPC router.
 *
 * Surface mirrors what was previously available via `orbital <cmd>` plus a
 * fresh health/metrics view that the CLI never had. Six logical groupings:
 *
 *   admin.health.live           — uptime + DB/MCP/WS subsystem health
 *   admin.health.ready          — equivalent of /health/ready, exposed via tRPC
 *   admin.metrics.snapshot      — Prometheus snapshot in object form
 *   admin.workers.list          — agent_workers rows
 *   admin.workers.kill          — SIGTERM by worker_id  (capability-gated)
 *   admin.keys.history          — signing_keys + key_history merged view
 *   admin.keys.rotate           — KeyManager.rotate     (capability-gated)
 *   admin.backup.list           — list past tarballs under <home>/backup/snapshots/
 *   admin.backup.export         — pg_dump+keychain → encrypted tarball  (capability-gated)
 *   admin.verify.attestation    — runVerify chain walk by capability_id or commit
 *   admin.reset.danger          — drop schemas + re-migrate     (capability-gated)
 *
 * V1 auth: every protected (capability-gated) procedure accepts `adminToken`
 * as part of its input. Middleware validates against keychain/env. See
 * src/admin/auth.ts for the resolution order and open-dev-mode behavior.
 *
 * No mock data. Real Postgres, real keychain, real pg_dump, real ed25519.
 */

import { z } from 'zod'
import path from 'node:path'
import fs from 'node:fs/promises'
import { TRPCError } from '@trpc/server'
import { eq, desc, sql as dSQL } from 'drizzle-orm'

import { router, publicProcedure } from '../init.js'
import { db, sql as sqlPool } from '../../db/client.js'
import { signingKeys, keyHistory } from '../../db/schema/capabilities.js'
import { agentWorkers } from '../../db/schema/worker-tables.js'
import { createEventStore } from '../../events/store.js'
import { logger } from '../../config/logger.js'
import { loadEnv, getOrbitalHome } from '../../config/env.js'

import { authorizeAdminRequest } from '../../admin/auth.js'
import type { Actor } from '@orbital/types'
import type { WorkerKilledByOperatorPayload } from '../../events/types.js'

import { runBackupExport } from '../../recovery/backup.js'
import { runKeysRotate } from '../../recovery/keys.js'
import { runReset } from '../../recovery/reset.js'
import { runVerify } from '../../recovery/verify.js'
import { HygieneService } from '../../admin/hygiene.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const adminTokenSchema = z.string().optional()

const protectedInput = z.object({ adminToken: adminTokenSchema })

const healthLiveOutput = z.object({
  uptimeSec: z.number(),
  startedAt: z.string(),
  installId: z.string(),
  subsystems: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'degraded', 'down']),
      detail: z.string().optional(),
    }),
  ),
})

const healthReadyOutput = z.object({
  ready: z.boolean(),
  timestamp: z.string(),
  detail: z.string().optional(),
})

const metricsSnapshotOutput = z.object({
  activeWorkers: z.number(),
  capabilityDenials: z.number(),
  sprintCostUsd: z.number(),
  sprintBudgetUsd: z.number().nullable(),
  exportsCompleted: z.number(),
  totalEvents: z.number(),
  collectedAt: z.string(),
})

const workerListOutput = z.array(
  z.object({
    workerId: z.string(),
    personaId: z.string(),
    status: z.enum(['connecting', 'active', 'idle', 'terminating', 'terminated']),
    taskId: z.string().nullable(),
    startedAt: z.string(),
    lastHeartbeatAt: z.string().nullable(),
    pid: z.number().nullable(),
    capabilityId: z.string(),
  }),
)

const workerKillInput = protectedInput.extend({
  workerId: z.string().uuid(),
  reason: z.string().min(1).max(256).default('admin_action'),
})

const workerKillOutput = z.object({
  workerId: z.string(),
  signalSent: z.boolean(),
  pidSignaled: z.number().nullable(),
  detail: z.string(),
})

const keysHistoryOutput = z.object({
  keys: z.array(
    z.object({
      keyId: z.string(),
      keyKind: z.enum(['master', 'sub']),
      parentKeyId: z.string().nullable(),
      sprintId: z.string().nullable(),
      status: z.enum(['active', 'retired', 'archived', 'compromised']),
      createdAt: z.string(),
      activeFrom: z.string(),
      activeUntil: z.string().nullable(),
      privateZeroizedAt: z.string().nullable(),
    }),
  ),
  history: z.array(
    z.object({
      historyId: z.string(),
      keyId: z.string(),
      transition: z.string(),
      transitionAt: z.string(),
    }),
  ),
})

const keysRotateInput = protectedInput.extend({
  sprintId: z.string().uuid().optional(),
})

const keysRotateOutput = z.object({
  retiredKeyId: z.string(),
  newKeyId: z.string(),
  rotatedEventId: z.string(),
  sprintId: z.string(),
})

const backupListOutput = z.array(
  z.object({
    filename: z.string(),
    path: z.string(),
    size: z.number(),
    createdAt: z.string(),
  }),
)

const backupExportInput = protectedInput.extend({
  /** Optional explicit passphrase. If omitted, falls back to keychain → env → error. */
  passphrase: z.string().min(8).optional(),
})

const backupExportOutput = z.object({
  outPath: z.string(),
  filename: z.string(),
  size: z.number(),
  installId: z.string(),
  /** Relative download URL the UI can link to. */
  downloadUrl: z.string(),
})

const verifyInput = z.object({
  input: z.string().min(1).max(128),
})

const verifyOutput = z.object({
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  commitNotAttested: z.boolean().optional(),
  details: z
    .object({
      capability_id: z.string(),
      persona_id: z.string(),
      task_id: z.string(),
      sprint_id: z.string(),
      sub_key_id: z.string(),
      master_key_id: z.string(),
      install_id: z.string(),
      issued_at: z.string(),
      expires_at: z.string(),
    })
    .optional(),
})

const resetInput = protectedInput.extend({
  confirmationPhrase: z.string(),
})

const resetOutput = z.object({
  newInstallId: z.string(),
  schemasDropped: z.literal(true),
  migrationsRun: z.literal(true),
})

// ---------------------------------------------------------------------------
// Hygiene schemas
// ---------------------------------------------------------------------------

const hygieneItemStory = z.object({
  storyId: z.string(),
  title: z.string(),
  status: z.string(),
  epicId: z.string(),
})

const hygieneItemSprint = z.object({
  sprintId: z.string(),
  name: z.string(),
  status: z.string(),
})

const hygieneItemEscalation = z.object({
  escalationId: z.string(),
  taskId: z.string(),
  reason: z.string(),
  createdAt: z.string(),
})

/** Shape for v2 aggregate sweep categories (no item details — only counts). */
const categoryResult = z.object({
  transitioned: z.number(),
  sampleIds: z.array(z.string()),
})

const hygieneResultShape = z.object({
  // v1 fields — unchanged
  stories: z.object({ archived: z.number(), items: z.array(hygieneItemStory) }),
  sprints: z.object({ archived: z.number(), items: z.array(hygieneItemSprint) }),
  escalations: z.object({ acknowledged: z.number(), items: z.array(hygieneItemEscalation) }),
  // v2 fields — aggressive sweep categories
  epics: categoryResult,
  visions: categoryResult,
  orphanCeremonies: categoryResult,
  orphanChannels: categoryResult,
  staleTasks: categoryResult,
  staleWorkers: categoryResult,
  staleCapabilities: categoryResult,
  staleVisionSessions: categoryResult,
  testDefects: categoryResult,
  dryRun: z.boolean(),
})

const hygieneRunInput = protectedInput.extend({
  /**
   * Safety acknowledgement — must be exactly 'I understand' to prevent
   * accidental sweeps on production data.
   */
  ack: z.literal('I understand'),
  /**
   * Override the minimum age (in days) for escalation cleanup.
   * 0 = all open escalations. Defaults to 30 on the service.
   */
  olderThanDays: z.number().int().min(0).optional(),
  /**
   * When false, the v2 aggressive sweep methods run for real.
   * Defaults to true (v2 dry-run) for safety until verified.
   */
  aggressiveDryRun: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }
const ADMIN_RESET_PHRASE = 'I understand this destroys everything'
const PROCESS_STARTED_AT = new Date()

let _eventStore: ReturnType<typeof createEventStore> | null = null
function getEventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sqlPool)
  return _eventStore
}

let _hygieneService: HygieneService | null = null
function getHygieneService(): HygieneService {
  if (_hygieneService === null) _hygieneService = new HygieneService(db, getEventStore())
  return _hygieneService
}

/**
 * Throw TRPCError UNAUTHORIZED if the request is not allowed by current auth
 * config. Returns silently when authorized.
 */
async function requireAdmin(token: string | undefined): Promise<void> {
  const env = loadEnv()
  const decision = await authorizeAdminRequest(token, env.NODE_ENV)
  if (!decision.allowed) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: decision.detail ?? `admin access denied (${decision.reasonCode})`,
    })
  }
}

/** Parse Prometheus text-format snapshot into a small object for the UI. */
function parsePromSnapshot(text: string): {
  activeWorkers: number
  capabilityDenials: number
  sprintCostUsd: number
  sprintBudgetUsd: number | null
  exportsCompleted: number
  totalEvents: number
} {
  const out = {
    activeWorkers: 0,
    capabilityDenials: 0,
    sprintCostUsd: 0,
    sprintBudgetUsd: null as number | null,
    exportsCompleted: 0,
    totalEvents: 0,
  }
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // metric_name{labels} value [timestamp]
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)(\{[^}]*\})?\s+([\d.eE+-]+)/.exec(line)
    if (!match) continue
    const name = match[1]!
    const value = Number(match[3]!)
    if (Number.isNaN(value)) continue

    switch (name) {
      case 'orbital_workers_active':
        out.activeWorkers = Math.max(out.activeWorkers, value)
        break
      case 'orbital_capability_denials_total':
        out.capabilityDenials = Math.max(out.capabilityDenials, value)
        break
      case 'orbital_sprint_cost_usd':
        out.sprintCostUsd = value
        break
      case 'orbital_sprint_budget_usd':
        out.sprintBudgetUsd = value
        break
      case 'orbital_audit_exports_completed_total':
        out.exportsCompleted = Math.max(out.exportsCompleted, value)
        break
      case 'orbital_events_total':
        out.totalEvents = Math.max(out.totalEvents, value)
        break
      default:
        break
    }
  }
  return out
}

async function readMetricsSnapshot(port: number, host: string): Promise<string> {
  const target = host === '0.0.0.0' ? '127.0.0.1' : host
  const url = `http://${target}:${String(port)}/metrics`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1500)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) {
      throw new Error(`metrics endpoint returned ${String(res.status)}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function snapshotFromDb(): Promise<{
  activeWorkers: number
  capabilityDenials: number
  totalEvents: number
  exportsCompleted: number
}> {
  // Fall-back path used when /metrics is unreachable. Direct DB queries.
  const [activeWorkersRows, denialRows, eventRows, exportRows] = await Promise.all([
    db.execute(
      dSQL`select count(*)::int as c from agent_workers where status in ('connecting','active','idle')`,
    ),
    db.execute(dSQL`select count(*)::int as c from capability_denials`),
    db.execute(dSQL`select count(*)::int as c from audit.events`),
    db.execute(
      dSQL`select count(*)::int as c from audit.audit_exports where status = 'completed'`,
    ),
  ])
  // drizzle execute returns a result with `.rows`; postgres.js style. Be defensive.
  const num = (r: unknown): number => {
    const rows = (r as { rows?: Array<{ c?: number }> }).rows
    if (rows && rows[0] && typeof rows[0].c === 'number') return rows[0].c
    // postgres.js returns plain array
    const arr = r as Array<{ c?: number }>
    if (Array.isArray(arr) && arr[0] && typeof arr[0].c === 'number') return arr[0].c
    return 0
  }
  return {
    activeWorkers: num(activeWorkersRows),
    capabilityDenials: num(denialRows),
    totalEvents: num(eventRows),
    exportsCompleted: num(exportRows),
  }
}

// ---------------------------------------------------------------------------
// Procedure factories
// ---------------------------------------------------------------------------

interface AdminRouterDeps {
  /** Test override — skip the real /metrics fetch. */
  metricsFetcher?: (port: number, host: string) => Promise<string>
  /** Test override — skip the real installId resolution. */
  installIdProvider?: () => Promise<string>
  /** Test override — skip the real worker SIGTERM (returns true on call). */
  signalSender?: (pid: number, sig: 'SIGTERM') => boolean
}

export function createAdminRouter(deps: AdminRouterDeps = {}) {
  const fetchMetrics = deps.metricsFetcher ?? readMetricsSnapshot
  const sendSignal: (pid: number, sig: 'SIGTERM') => boolean =
    deps.signalSender ??
    ((pid, sig) => {
      try {
        process.kill(pid, sig)
        return true
      } catch (err) {
        logger.warn({ err, pid }, 'admin.workers.kill: process.kill failed')
        return false
      }
    })
  const installIdProvider =
    deps.installIdProvider ??
    (async () => {
      const { getInstallId } = await import('../../config/install.js')
      return getInstallId()
    })

  return router({
    // -----------------------------------------------------------------------
    // health
    // -----------------------------------------------------------------------
    health: router({
      live: publicProcedure.output(healthLiveOutput).query(async () => {
        const installId = await installIdProvider()

        // Probe DB
        let dbStatus: 'ok' | 'down' = 'ok'
        let dbDetail: string | undefined
        try {
          await sqlPool`SELECT 1`
        } catch (err) {
          dbStatus = 'down'
          dbDetail = (err as Error).message.slice(0, 200)
        }

        // Probe MCP gateway socket — best-effort; absence is not fatal
        let mcpStatus: 'ok' | 'degraded' | 'down' = 'ok'
        let mcpDetail: string | undefined
        try {
          const sock = path.join(getOrbitalHome(), 'orbital.sock')
          await fs.access(sock)
        } catch {
          mcpStatus = 'degraded'
          mcpDetail = 'MCP gateway socket not present at <orbital_home>/orbital.sock'
        }

        // WS hub: there's no direct probe from inside a tRPC procedure other
        // than verifying the orchestrator is up — which it is, since this
        // procedure is executing. Reported as ok unless DB is down.
        const wsStatus: 'ok' | 'degraded' = dbStatus === 'ok' ? 'ok' : 'degraded'

        return {
          uptimeSec: process.uptime(),
          startedAt: PROCESS_STARTED_AT.toISOString(),
          installId,
          subsystems: [
            { name: 'database', status: dbStatus, detail: dbDetail },
            { name: 'ws_hub', status: wsStatus },
            { name: 'mcp_gateway', status: mcpStatus, detail: mcpDetail },
          ],
        }
      }),

      ready: publicProcedure.output(healthReadyOutput).query(async () => {
        try {
          await sqlPool`SELECT 1`
          return { ready: true, timestamp: new Date().toISOString() }
        } catch (err) {
          return {
            ready: false,
            timestamp: new Date().toISOString(),
            detail: (err as Error).message.slice(0, 200),
          }
        }
      }),
    }),

    // -----------------------------------------------------------------------
    // metrics
    // -----------------------------------------------------------------------
    metrics: router({
      snapshot: publicProcedure.output(metricsSnapshotOutput).query(async () => {
        const env = loadEnv()
        let parsed = {
          activeWorkers: 0,
          capabilityDenials: 0,
          sprintCostUsd: 0,
          sprintBudgetUsd: null as number | null,
          exportsCompleted: 0,
          totalEvents: 0,
        }
        try {
          const text = await fetchMetrics(env.PORT, env.HOST)
          parsed = parsePromSnapshot(text)
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            'admin.metrics.snapshot: /metrics unreachable; falling back to DB',
          )
          const fb = await snapshotFromDb()
          parsed.activeWorkers = fb.activeWorkers
          parsed.capabilityDenials = fb.capabilityDenials
          parsed.totalEvents = fb.totalEvents
          parsed.exportsCompleted = fb.exportsCompleted
        }
        return {
          ...parsed,
          collectedAt: new Date().toISOString(),
        }
      }),
    }),

    // -----------------------------------------------------------------------
    // workers
    // -----------------------------------------------------------------------
    workers: router({
      list: publicProcedure.output(workerListOutput).query(async () => {
        const rows = await db
          .select()
          .from(agentWorkers)
          .orderBy(desc(agentWorkers.startedAt))
          .limit(200)
        return rows.map((r) => ({
          workerId: r.workerId,
          personaId: r.personaId,
          status: r.status,
          taskId: r.taskId ?? null,
          startedAt: (r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt)),
          lastHeartbeatAt: r.lastHeartbeatAt
            ? r.lastHeartbeatAt instanceof Date
              ? r.lastHeartbeatAt.toISOString()
              : String(r.lastHeartbeatAt)
            : null,
          pid: r.pid ?? null,
          capabilityId: r.capabilityId,
        }))
      }),

      kill: publicProcedure
        .input(workerKillInput)
        .output(workerKillOutput)
        .mutation(async ({ input }) => {
          await requireAdmin(input.adminToken)

          const rows = await db
            .select()
            .from(agentWorkers)
            .where(eq(agentWorkers.workerId, input.workerId))
            .limit(1)
          const row = rows[0]
          if (!row) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `worker ${input.workerId} not found`,
            })
          }

          let signalSent = false
          let pidSignaled: number | null = null
          let detail: string

          if (row.pid !== null && row.pid !== undefined && row.pid > 0) {
            const ok = sendSignal(row.pid, 'SIGTERM')
            signalSent = ok
            pidSignaled = row.pid
            detail = ok
              ? `SIGTERM sent to pid ${String(row.pid)}`
              : `SIGTERM to pid ${String(row.pid)} failed (process may already be gone)`
          } else {
            detail = 'no recorded PID for this worker; emitting audit event only'
          }

          // Emit AdminWorkerKilled even if SIGTERM failed — the action was attempted.
          // 'system' aggregate type because agent_worker is not in the canonical
          // AggregateTypeSchema; the worker_id is preserved in the payload.
          await getEventStore().append({
            aggregate_id: row.workerId,
            aggregate_type: 'system',
            event_type: 'AdminWorkerKilled',
            payload: {
              worker_id: row.workerId,
              persona_id: row.personaId,
              task_id: row.taskId,
              pid_signaled: pidSignaled,
              signal_sent: signalSent,
              reason: input.reason,
            },
            actor: SYSTEM_ACTOR,
            trace_id: `admin-worker-kill-${row.workerId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })

          // Mark the row as terminating so the dashboard reflects the action.
          await db
            .update(agentWorkers)
            .set({ status: 'terminating' })
            .where(eq(agentWorkers.workerId, row.workerId))

          // Round 6 #10 — emit WorkerKilledByOperator for inspection layer fan-out.
          // This event is aggregate_type='orchestration' so hub.ts routes it to
          // inspection:active and inspection:worker:<id> subscriptions.
          // [Engineer-Sr · Sonnet · run-round6-10-inspection-followup]
          const killedAt = new Date().toISOString()
          const operatorInstallId = await installIdProvider().catch(() => 'unknown')
          const killedPayload: WorkerKilledByOperatorPayload = {
            worker_id: row.workerId,
            operator_id: operatorInstallId,
            reason: input.reason,
            killed_at: killedAt,
          }
          await getEventStore().append({
            aggregate_id: row.workerId,
            aggregate_type: 'orchestration',
            event_type: 'WorkerKilledByOperator',
            payload: killedPayload as unknown as Record<string, unknown>,
            actor: SYSTEM_ACTOR,
            trace_id: `admin-worker-kill-operator-${row.workerId}`,
            occurred_at: killedAt,
            schema_version: 1,
          })

          return {
            workerId: row.workerId,
            signalSent,
            pidSignaled,
            detail,
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // keys
    // -----------------------------------------------------------------------
    keys: router({
      history: publicProcedure.output(keysHistoryOutput).query(async () => {
        const [keys, history] = await Promise.all([
          db.select().from(signingKeys).orderBy(desc(signingKeys.created_at)).limit(200),
          db.select().from(keyHistory).orderBy(desc(keyHistory.transition_at)).limit(500),
        ])
        return {
          keys: keys.map((k) => ({
            keyId: k.key_id,
            keyKind: k.key_kind,
            parentKeyId: k.parent_key_id ?? null,
            sprintId: k.sprint_id ?? null,
            status: k.status,
            createdAt: k.created_at instanceof Date ? k.created_at.toISOString() : String(k.created_at),
            activeFrom:
              k.active_from instanceof Date ? k.active_from.toISOString() : String(k.active_from),
            activeUntil: k.active_until
              ? k.active_until instanceof Date
                ? k.active_until.toISOString()
                : String(k.active_until)
              : null,
            privateZeroizedAt: k.private_zeroized_at
              ? k.private_zeroized_at instanceof Date
                ? k.private_zeroized_at.toISOString()
                : String(k.private_zeroized_at)
              : null,
          })),
          history: history.map((h) => ({
            historyId: h.history_id,
            keyId: h.key_id,
            transition: h.transition,
            transitionAt:
              h.transition_at instanceof Date ? h.transition_at.toISOString() : String(h.transition_at),
          })),
        }
      }),

      rotate: publicProcedure
        .input(keysRotateInput)
        .output(keysRotateOutput)
        .mutation(async ({ input }) => {
          await requireAdmin(input.adminToken)

          // Audit-log the request before invoking. Even if rotate throws, we
          // capture the intent.
          const installId = await installIdProvider()
          await getEventStore().append({
            aggregate_id: installId,
            aggregate_type: 'install',
            event_type: 'AdminKeyRotationRequested',
            payload: {
              sprint_id: input.sprintId ?? null,
              requested_at: new Date().toISOString(),
            },
            actor: SYSTEM_ACTOR,
            trace_id: `admin-keys-rotate-${installId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })

          try {
            const result = await runKeysRotate({
              sprintId: input.sprintId,
              keepDbOpen: true,
            })
            return result
          } catch (err) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: (err as Error).message,
              cause: err,
            })
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // backup
    // -----------------------------------------------------------------------
    backup: router({
      list: publicProcedure.output(backupListOutput).query(async () => {
        const home = getOrbitalHome()
        const dir = path.join(home, 'backup', 'snapshots')
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          const out: Array<{ filename: string; path: string; size: number; createdAt: string }> = []
          for (const e of entries) {
            if (!e.isFile()) continue
            const full = path.join(dir, e.name)
            try {
              const stat = await fs.stat(full)
              out.push({
                filename: e.name,
                path: full,
                size: stat.size,
                createdAt: stat.birthtime.toISOString(),
              })
            } catch {
              /* skip unreadable */
            }
          }
          // newest first
          out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          return out
        } catch (err) {
          if ((err as { code?: string }).code === 'ENOENT') return []
          throw err
        }
      }),

      export: publicProcedure
        .input(backupExportInput)
        .output(backupExportOutput)
        .mutation(async ({ input }) => {
          await requireAdmin(input.adminToken)

          const installId = await installIdProvider()
          await getEventStore().append({
            aggregate_id: installId,
            aggregate_type: 'install',
            event_type: 'AdminBackupRequested',
            payload: {
              requested_at: new Date().toISOString(),
            },
            actor: SYSTEM_ACTOR,
            trace_id: `admin-backup-${installId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })

          try {
            const result = await runBackupExport({
              passphrase: input.passphrase,
            })
            const filename = path.basename(result.outPath)
            return {
              outPath: result.outPath,
              filename,
              size: result.size,
              installId: result.installId,
              // The UI can fetch the file via this URL once a download
              // route is added; for v1 the file path is exposed for
              // operator awareness but downloads happen out-of-band.
              downloadUrl: `/api/v1/admin/backup/${encodeURIComponent(filename)}`,
            }
          } catch (err) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: (err as Error).message,
              cause: err,
            })
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // verify
    // -----------------------------------------------------------------------
    verify: router({
      attestation: publicProcedure
        .input(verifyInput)
        .output(verifyOutput)
        .query(async ({ input }) => {
          const result = await runVerify(input.input, { keepDbOpen: true })
          return {
            ok: result.ok,
            code: result.code,
            message: result.message,
            commitNotAttested: result.commitNotAttested,
            details: result.details,
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // reset
    // -----------------------------------------------------------------------
    reset: router({
      danger: publicProcedure
        .input(resetInput)
        .output(resetOutput)
        .mutation(async ({ input }) => {
          await requireAdmin(input.adminToken)

          if (input.confirmationPhrase !== ADMIN_RESET_PHRASE) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                `confirmation phrase must be exactly: ${ADMIN_RESET_PHRASE}`,
            })
          }

          // Audit-log the request before destruction. The events table is
          // about to be dropped, so this row is short-lived — but it is
          // captured by any subscribed WS clients prior to the drop.
          const installId = await installIdProvider()
          await getEventStore().append({
            aggregate_id: installId,
            aggregate_type: 'install',
            event_type: 'AdminResetRequested',
            payload: {
              requested_at: new Date().toISOString(),
            },
            actor: SYSTEM_ACTOR,
            trace_id: `admin-reset-${installId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })

          try {
            const result = await runReset({
              confirmed: true,
              forceWhileRunning: true, // we are the daemon; runReset's running-daemon check would otherwise refuse
              keepDbOpen: true,
            })
            return result
          } catch (err) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: (err as Error).message,
              cause: err,
            })
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // hygiene
    // -----------------------------------------------------------------------
    hygiene: router({
      /**
       * admin.hygiene.preview — dry-run sweep; returns counts + sample items.
       * No data is mutated.
       */
      preview: publicProcedure.output(hygieneResultShape).query(async () => {
        return getHygieneService().runFullSweep({ dryRun: true })
      }),

      /**
       * admin.hygiene.run — executes the sweep for real.
       * Requires admin token + ack='I understand' to prevent accidents.
       */
      run: publicProcedure
        .input(hygieneRunInput)
        .output(hygieneResultShape)
        .mutation(async ({ input }) => {
          await requireAdmin(input.adminToken)

          return getHygieneService().runFullSweep({
            dryRun: false,
            olderThanDays: input.olderThanDays,
            aggressiveDryRun: input.aggressiveDryRun,
          })
        }),
    }),
  })
}

export type AdminRouter = ReturnType<typeof createAdminRouter>

// Lazy singleton — same pattern as onboarding/uat/retro routers.
let _router: AdminRouter | null = null
export function adminRouter(): AdminRouter {
  if (_router === null) _router = createAdminRouter()
  return _router
}

// Test helper — reset the cached router (used by router-level tests).
export function _resetAdminRouterCache(): void {
  _router = null
  _eventStore = null
  _hygieneService = null
}
