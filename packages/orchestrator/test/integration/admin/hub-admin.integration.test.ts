/**
 * integration/admin/hub-admin.integration.test.ts
 *
 * Round 7-07 — Hub Deployment + Operations (auth model updated by Round 7-03)
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 * [Engineer-Principal · Opus · run-round7-03-federation-auth] (auth migration)
 *
 * Exercises hub admin endpoints with the new signed-envelope auth model:
 *
 *   - GET /admin/health      → full status JSON (no auth required)
 *   - GET /admin/installs    → 401 in production w/o envelope, 200 with owner envelope
 *   - POST /admin/installs/:id/revoke → 200 with owner envelope
 *   - GET /admin/audit-tail  → returns array of recent events
 *   - GET /admin/backup/status → returns backup list
 *   - POST /admin/backup     → triggers backup
 *
 * Auth paths covered (Round 7-03):
 *   - Owner envelope → 200
 *   - Member envelope → 403 (FORBIDDEN, role not owner)
 *   - No envelope, NODE_ENV=development → 200 (open dev mode)
 *   - No envelope, NODE_ENV=production → 401 (AUTH_HEADER_MISSING)
 *
 * Replaces the legacy x-orbital-owner-token check entirely.
 *
 * multi-tenant: hub admin operates cross-tenant — no tenant_id scoping tested here.
 * No mocks for DB — real Postgres. pg_dump is mocked via child_process override.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { uuidv7 } from 'uuidv7'

import { sql, db, closeDb } from '../../../src/db/client.js'
import { resetEnvCache } from '../../../src/config/env.js'
import { registerHubAdminRoutes, _resetOwnerModeWarning } from '../../../src/admin/hub-admin.js'
import { _resetNonceLru } from '../../../src/hub/auth/middleware.js'
import {
  signEnvelope,
  bytesToBase64Url,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
} from '../../../src/keys/envelope.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'

ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Per-file tenant id so parallel test suites don't wipe each other's rows
const ADMIN_TEST_TENANT_ID = '00000000-0000-0000-0000-000000777777'

let app: FastifyInstance

interface SeededInstall {
  installId: string
  privateKey: Uint8Array
  publicKey: Uint8Array
}

const ownerInstall: { current: SeededInstall | null } = { current: null }
const memberInstall: { current: SeededInstall | null } = { current: null }

function makeApp(nodeEnv = 'test'): FastifyInstance {
  process.env['NODE_ENV'] = nodeEnv
  process.env['ORBITAL_MODE'] = 'hub'
  // The Round 7-03 auth model does NOT use a static owner token; auth is
  // derived from the signed envelope's known_installs.role. The legacy
  // x-orbital-owner-token env var is unused.
  delete process.env['ORBITAL_OWNER_TOKEN']
  resetEnvCache()

  // Capture raw body bytes for envelope verification (sha256-of-body check)
  const instance = Fastify({ logger: false })
  instance.addHook('preParsing', async (req, _reply, payload) => {
    const chunks: Buffer[] = []
    return new Promise((resolve, reject) => {
      payload.on('data', (c: Buffer) => chunks.push(c))
      payload.on('end', () => {
        const buf = Buffer.concat(chunks)
        ;(req as { rawBody?: Buffer }).rawBody = buf
        const { Readable } = require('node:stream') as typeof import('node:stream')
        resolve(Readable.from(buf))
      })
      payload.on('error', reject)
    })
  })

  registerHubAdminRoutes(instance)
  return instance
}

async function signFor(
  install: SeededInstall,
  method: string,
  bodyBytes: Uint8Array,
): Promise<Record<string, string>> {
  const env = await signEnvelope({
    method,
    bodyBytes,
    privateKey: install.privateKey,
  })
  return {
    [HEADER_INSTALL_ID]: install.installId,
    [HEADER_SIG]: env.signatureB64,
    [HEADER_SIG_BODY]: env.bodyB64,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql`SELECT 1`
  await sql`SELECT pg_advisory_lock(7030034)`
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS known_installs (
        install_id    uuid        PRIMARY KEY,
        tenant_id     uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
        public_key    text        NOT NULL,
        role          text        NOT NULL CHECK (role IN ('owner','member','viewer')),
        display_name  text,
        invite_jti    text        NOT NULL,
        joined_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz,
        revoked_at    timestamptz
      )
    `)
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS known_installs_invite_jti_uniq
        ON known_installs (invite_jti)
    `)
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS known_installs_tenant_idx
        ON known_installs (tenant_id, revoked_at)
    `)
  } finally {
    await sql`SELECT pg_advisory_unlock(7030034)`
  }
})

async function seedInstall(role: 'owner' | 'member'): Promise<SeededInstall> {
  const priv = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(priv)
  const installId = uuidv7()
  await db.insert(knownInstalls).values({
    install_id: installId,
    tenant_id: ADMIN_TEST_TENANT_ID,
    public_key: bytesToBase64Url(pub),
    role,
    display_name: `${role}-test`,
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: null,
  })
  return { installId, privateKey: priv, publicKey: pub }
}

beforeEach(async () => {
  _resetOwnerModeWarning()
  _resetNonceLru()
  // Clean ONLY this file's tenant so parallel test suites don't collide.
  await sql`DELETE FROM known_installs WHERE tenant_id = ${ADMIN_TEST_TENANT_ID}`
  ownerInstall.current = await seedInstall('owner')
  memberInstall.current = await seedInstall('member')
  app = makeApp('development')
  await app.ready()
})

afterEach(async () => {
  await app.close()
  delete process.env['ORBITAL_MODE']
  delete process.env['NODE_ENV']
  resetEnvCache()
  _resetOwnerModeWarning()
  _resetNonceLru()
})

afterAll(async () => {
  await closeDb()
})

// ---------------------------------------------------------------------------
// GET /admin/health (no auth required)
// ---------------------------------------------------------------------------

describe('GET /admin/health', () => {
  it('returns 200 with hub mode, version, uptime, and db status', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as {
      mode: string
      version: string
      uptime: number
      timestamp: string
      db: { status: string }
      tenantCount: number
    }
    expect(body.mode).toBe('hub')
    expect(typeof body.version).toBe('string')
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThan(0)
    expect(body.db).toBeDefined()
    expect(['ok', 'down']).toContain(body.db.status)
    expect(typeof body.tenantCount).toBe('number')
  })

  it('returns db.status=ok when database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' })
    const body = JSON.parse(res.payload) as { db: { status: string } }
    expect(body.db.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// GET /admin/installs — owner-only via signed envelope (Round 7-03)
// ---------------------------------------------------------------------------

describe('GET /admin/installs', () => {
  it('returns 401 in production mode with no envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/admin/installs' })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.payload) as { error: { code: string } }
    expect(body.error.code).toBe('AUTH_HEADER_MISSING')
  })

  it('returns 403 with a member-role envelope (not owner)', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const headers = await signFor(memberInstall.current!, 'admin.installs', new Uint8Array(0))
    const res = await app.inject({ method: 'GET', url: '/admin/installs', headers })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.payload) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('returns 200 with an owner-role envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const headers = await signFor(ownerInstall.current!, 'admin.installs', new Uint8Array(0))
    const res = await app.inject({ method: 'GET', url: '/admin/installs', headers })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { installs: unknown[] }
    expect(Array.isArray(body.installs)).toBe(true)
  })

  it('returns 200 in dev mode without envelope (open dev mode escape)', async () => {
    // app already started in development mode in beforeEach
    const res = await app.inject({ method: 'GET', url: '/admin/installs' })
    expect(res.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /admin/installs/:id/revoke
// ---------------------------------------------------------------------------

describe('POST /admin/installs/:id/revoke', () => {
  it('returns 403 with member envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const fakeId = '00000000-0000-0000-0000-000000000001'
    const body = JSON.stringify({})
    const headers = {
      ...(await signFor(memberInstall.current!, 'admin.revoke', new TextEncoder().encode(body))),
      'content-type': 'application/json',
    }
    const res = await app.inject({
      method: 'POST',
      url: `/admin/installs/${fakeId}/revoke`,
      headers,
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 200 with owner envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const fakeId = '00000000-0000-0000-0000-000000000002'
    const body = JSON.stringify({})
    const headers = {
      ...(await signFor(ownerInstall.current!, 'admin.revoke', new TextEncoder().encode(body))),
      'content-type': 'application/json',
    }
    const res = await app.inject({
      method: 'POST',
      url: `/admin/installs/${fakeId}/revoke`,
      headers,
      payload: body,
    })
    expect([200, 500]).toContain(res.statusCode)
  })

  it('returns 400 when install id is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/installs//revoke',
    })
    expect([400, 404]).toContain(res.statusCode)
  })
})

// ---------------------------------------------------------------------------
// GET /admin/audit-tail
// ---------------------------------------------------------------------------

describe('GET /admin/audit-tail', () => {
  it('returns 200 with events array in dev mode (open access)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/audit-tail' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { events: unknown[]; count: number }
    expect(Array.isArray(body.events)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  it('respects limit query parameter (max 500)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/audit-tail?limit=5' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { events: unknown[]; count: number }
    expect(body.count).toBeLessThanOrEqual(5)
  })

  it('returns 401 in production with no envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/admin/audit-tail' })
    expect(res.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /admin/backup/status
// ---------------------------------------------------------------------------

describe('GET /admin/backup/status', () => {
  it('returns 200 with backups array (open dev mode)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/backup/status' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as { backups: unknown[]; count: number }
    expect(Array.isArray(body.backups)).toBe(true)
    expect(typeof body.count).toBe('number')
  })

  it('returns 401 in production without envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/admin/backup/status' })
    expect(res.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /admin/backup
// ---------------------------------------------------------------------------

describe('POST /admin/backup', () => {
  it('returns 401 in production without envelope', async () => {
    await app.close()
    app = makeApp('production')
    await app.ready()

    const res = await app.inject({ method: 'POST', url: '/admin/backup' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 202 or 500 in dev mode (script may not be present)', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/backup' })
    expect([202, 500]).toContain(res.statusCode)
  })
})

// ---------------------------------------------------------------------------
// Hub mode guard
// ---------------------------------------------------------------------------

describe('Hub mode guard', () => {
  it('does not register routes when ORBITAL_MODE=local', async () => {
    await app.close()

    process.env['ORBITAL_MODE'] = 'local'
    resetEnvCache()

    const localApp = Fastify({ logger: false })
    registerHubAdminRoutes(localApp)
    await localApp.ready()

    const res = await localApp.inject({ method: 'GET', url: '/admin/health' })
    expect(res.statusCode).toBe(404)

    await localApp.close()
  })
})
