/**
 * test/integration/hub/auth-middleware.integration.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * End-to-end auth middleware behaviour against a real Postgres-backed
 * known_installs table. No mocks.
 *
 * Verifies the eight signed-envelope failure modes:
 *   - 401 AUTH_HEADER_MISSING     when envelope headers absent
 *   - 401 AUTH_SIG_INVALID        when sig is bogus
 *   - 401 AUTH_TS_EXPIRED         when ts skew > 60s
 *   - 401 AUTH_REPLAY             when nonce already seen
 *   - 401 AUTH_PARAMS_MISMATCH    when body sha256 differs
 *   - 401 AUTH_BODY_MALFORMED     when sig-body is junk
 *   - 401 INSTALL_UNKNOWN         when install_id not in known_installs
 *   - 401 INSTALL_REVOKED         when revoked_at IS NOT NULL
 *
 * Also confirms the happy path: a valid envelope returns ctx.installId,
 * ctx.tenantId, ctx.role.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import { eq } from 'drizzle-orm'
import {
  signEnvelope,
  bytesToBase64Url,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
  NonceLru,
} from '../../../src/keys/envelope.js'
import {
  verifyRequest,
  _resetNonceLru,
} from '../../../src/hub/auth/middleware.js'

ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

// Per-file tenant id so parallel test suites don't wipe each other's rows
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000888888'

beforeAll(async () => {
  await sql`SELECT 1`
  // Bootstrap the table; serialize across parallel test workers via advisory lock.
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

afterAll(async () => {
  await closeDb()
})

beforeEach(async () => {
  // Only delete rows scoped to this file's tenant so parallel test suites
  // don't wipe each other's seeded installs.
  await sql`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
  _resetNonceLru()
})

interface SeededInstall {
  installId: string
  publicKey: Uint8Array
  privateKey: Uint8Array
  pubB64: string
}

async function seedInstall(opts: {
  role?: 'owner' | 'member' | 'viewer'
  revoked?: boolean
  tenantId?: string
}): Promise<SeededInstall> {
  const priv = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(priv)
  const pubB64 = bytesToBase64Url(pub)
  const installId = uuidv7()

  await db.insert(knownInstalls).values({
    install_id: installId,
    tenant_id: opts.tenantId ?? TEST_TENANT_ID,
    public_key: pubB64,
    role: opts.role ?? 'member',
    display_name: 'test-laptop',
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: opts.revoked ? new Date() : null,
  })

  return { installId, publicKey: pub, privateKey: priv, pubB64 }
}

async function buildHeaders(opts: {
  install: SeededInstall
  method: string
  bodyBytes: Uint8Array
  nowMs?: number
  nonce?: string
}): Promise<Record<string, string>> {
  const env = await signEnvelope({
    method: opts.method,
    bodyBytes: opts.bodyBytes,
    privateKey: opts.install.privateKey,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  })
  return {
    [HEADER_INSTALL_ID]: opts.install.installId,
    [HEADER_SIG]: env.signatureB64,
    [HEADER_SIG_BODY]: env.bodyB64,
  }
}

describe('verifyRequest (envelope auth middleware)', () => {
  it('passes a valid envelope and returns the install identity', async () => {
    const install = await seedInstall({ role: 'member' })
    const body = new TextEncoder().encode('{"tenant_id":"x"}')
    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
    })

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.identity.installId).toBe(install.installId)
      expect(result.identity.tenantId).toBe(TEST_TENANT_ID)
      expect(result.identity.role).toBe('member')
    }
  })

  it('rejects requests with no envelope headers (AUTH_HEADER_MISSING)', async () => {
    const result = await verifyRequest({
      headers: {},
      requestBodyBytes: new Uint8Array(0),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_HEADER_MISSING')
    }
  })

  it('rejects unknown install_id (INSTALL_UNKNOWN)', async () => {
    const headers = {
      [HEADER_INSTALL_ID]: uuidv7(),
      [HEADER_SIG]: 'AAAA',
      [HEADER_SIG_BODY]: bytesToBase64Url(new TextEncoder().encode('{}')),
    }
    const result = await verifyRequest({
      headers,
      requestBodyBytes: new Uint8Array(0),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INSTALL_UNKNOWN')
    }
  })

  it('rejects revoked installs (INSTALL_REVOKED)', async () => {
    const install = await seedInstall({ revoked: true })
    const body = new Uint8Array(0)
    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
    })

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INSTALL_REVOKED')
    }
  })

  it('rejects expired ts (AUTH_TS_EXPIRED, drift > 60s)', async () => {
    const install = await seedInstall({})
    const body = new Uint8Array(0)
    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
      nowMs: Date.now() - 5 * 60_000, // 5 min stale
    })

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_TS_EXPIRED')
    }
  })

  it('rejects body tampering (AUTH_PARAMS_MISMATCH)', async () => {
    const install = await seedInstall({})
    const original = new TextEncoder().encode('{"a":1}')
    const tampered = new TextEncoder().encode('{"a":999}')
    const headers = await buildHeaders({
      install,
      method: 'tasks.update',
      bodyBytes: original,
    })

    const result = await verifyRequest({
      headers,
      // Hand the middleware a body that does NOT match the signed sha256
      requestBodyBytes: tampered,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_PARAMS_MISMATCH')
    }
  })

  it('rejects bad signatures (AUTH_SIG_INVALID)', async () => {
    const install = await seedInstall({})
    const body = new Uint8Array(0)
    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
    })
    // Mangle the sig
    headers[HEADER_SIG] = 'AAAAAAAAAAAA'

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_SIG_INVALID')
    }
  })

  it('rejects malformed sig-body (AUTH_BODY_MALFORMED)', async () => {
    const install = await seedInstall({})
    const headers: Record<string, string> = {
      [HEADER_INSTALL_ID]: install.installId,
      [HEADER_SIG]: 'AAAA',
      [HEADER_SIG_BODY]: bytesToBase64Url(new TextEncoder().encode('not-json{[')),
    }

    const result = await verifyRequest({
      headers,
      requestBodyBytes: new Uint8Array(0),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_BODY_MALFORMED')
    }
  })

  it('rejects replayed nonce (AUTH_REPLAY)', async () => {
    const install = await seedInstall({})
    const body = new Uint8Array(0)
    const lru = new NonceLru({ capacity: 100, ttlMs: 60_000 })

    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
      nonce: 'fixed-nonce-for-replay-test',
    })

    // First call: ok
    const r1 = await verifyRequest({
      headers,
      requestBodyBytes: body,
      nonceLru: lru,
    })
    expect(r1.ok).toBe(true)

    // Second call with the SAME nonce: replay
    const r2 = await verifyRequest({
      headers,
      requestBodyBytes: body,
      nonceLru: lru,
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe('AUTH_REPLAY')
    }
  })

  it('updates last_seen_at on successful verification (best-effort)', async () => {
    const install = await seedInstall({})
    const body = new Uint8Array(0)
    const headers = await buildHeaders({
      install,
      method: 'tasks.list',
      bodyBytes: body,
    })

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(result.ok).toBe(true)

    // Wait briefly for the best-effort touchLastSeen to fire
    await new Promise((r) => setTimeout(r, 200))

    const rows = await db
      .select()
      .from(knownInstalls)
      .where(eq(knownInstalls.install_id, install.installId))
    expect(rows[0]!.last_seen_at).not.toBeNull()
  })

  it('two paired installs each get distinct ctx.installId on the same hub (AC6)', async () => {
    const matt = await seedInstall({ role: 'member' })
    const ricky = await seedInstall({ role: 'member' })

    const body = new TextEncoder().encode('{}')
    const mattHeaders = await buildHeaders({
      install: matt,
      method: 'tasks.list',
      bodyBytes: body,
    })
    const rickyHeaders = await buildHeaders({
      install: ricky,
      method: 'tasks.list',
      bodyBytes: body,
    })

    const r1 = await verifyRequest({ headers: mattHeaders, requestBodyBytes: body })
    const r2 = await verifyRequest({ headers: rickyHeaders, requestBodyBytes: body })

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) {
      expect(r1.identity.installId).toBe(matt.installId)
      expect(r2.identity.installId).toBe(ricky.installId)
      expect(r1.identity.installId).not.toBe(r2.identity.installId)
      // Same tenant, distinct install identity
      expect(r1.identity.tenantId).toBe(r2.identity.tenantId)
    }
  })

  it('returns owner role when the install was registered as owner', async () => {
    const install = await seedInstall({ role: 'owner' })
    const body = new Uint8Array(0)
    const headers = await buildHeaders({
      install,
      method: 'admin.installs.list',
      bodyBytes: body,
    })

    const result = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.identity.role).toBe('owner')
    }
  })
})
