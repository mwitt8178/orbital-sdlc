/**
 * test/integration/hub/registration.integration.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Real Postgres. Real crypto. No mocks.
 *
 * Exercises the hub registration handshake end-to-end:
 *   - Mint an invite via mintInvite()
 *   - Generate an Ed25519 keypair (via @noble/ed25519 directly)
 *   - Call registerHandler() with the public key + invite token
 *   - Verify a known_installs row was inserted
 *   - Verify reuse of the same invite is rejected with AUTH_INVITE_ALREADY_USED
 *   - Verify expired invite is rejected with AUTH_INVITE_EXPIRED
 *   - Verify malformed invite is rejected with AUTH_INVITE_INVALID
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import { eq } from 'drizzle-orm'
import {
  mintInvite,
  registerHandler,
} from '../../../src/hub/auth/registration.js'
import { bytesToBase64Url } from '../../../src/keys/envelope.js'
import { resetEnvCache } from '../../../src/config/env.js'

ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

const TEST_MASTER_KEY = 'test-hub-master-key-0123456789abcdef0123456789abcdef'
// Per-file tenant id so parallel test suites don't wipe each other's rows
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000999999'

beforeAll(async () => {
  process.env['ORBITAL_HUB_MASTER_KEY'] = TEST_MASTER_KEY
  process.env['ORBITAL_HUB_TENANT_ID'] = TEST_TENANT_ID
  resetEnvCache()

  // Ensure the migration has run; if known_installs doesn't exist yet, this
  // setup runs CREATE TABLE so the test is self-bootstrapping. Uses a
  // postgres advisory lock to serialize bootstrap across parallel test
  // workers (each worker owns its own connection, so without the lock two
  // processes race CREATE TYPE/CREATE TABLE for the same enum/relation).
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

afterAll(async () => {
  await closeDb()
})

beforeEach(async () => {
  // Clean ONLY this file's tenant so parallel test suites don't collide.
  await sql`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
})

async function freshKeypair(): Promise<{ priv: Uint8Array; pub: Uint8Array; pubB64: string }> {
  const priv = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(priv)
  return { priv, pub, pubB64: bytesToBase64Url(pub) }
}

describe('hub register flow', () => {
  it('registers a fresh install with a valid invite', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })
    const { pubB64 } = await freshKeypair()
    const installId = uuidv7()

    const result = await registerHandler({
      install_id: installId,
      public_key: pubB64,
      display_name: 'matt-laptop',
      invite_token: token,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.install_id).toBe(installId)
      expect(result.tenant_id).toBe(TEST_TENANT_ID)
      expect(result.role).toBe('member')
      expect(result.hub_pubkey.length).toBeGreaterThan(0)
    }

    // Verify the row exists in DB
    const rows = await db
      .select()
      .from(knownInstalls)
      .where(eq(knownInstalls.install_id, installId))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.role).toBe('member')
    expect(row.public_key).toBe(pubB64)
    expect(row.display_name).toBe('matt-laptop')
    expect(row.revoked_at).toBeNull()
  })

  it('rejects a reused invite token (single-use enforced via unique invite_jti)', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })

    // First registration → ok
    const { pubB64: pub1 } = await freshKeypair()
    const r1 = await registerHandler({
      install_id: uuidv7(),
      public_key: pub1,
      invite_token: token,
    })
    expect(r1.ok).toBe(true)

    // Second registration with the SAME token → must fail
    const { pubB64: pub2 } = await freshKeypair()
    const r2 = await registerHandler({
      install_id: uuidv7(),
      public_key: pub2,
      invite_token: token,
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe('AUTH_INVITE_ALREADY_USED')
    }
  })

  it('rejects an expired invite', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
      // Expired 60 seconds ago
      ttlSec: 1,
      nowSec: Math.floor(Date.now() / 1000) - 120,
    })
    const { pubB64 } = await freshKeypair()

    const result = await registerHandler({
      install_id: uuidv7(),
      public_key: pubB64,
      invite_token: token,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_INVITE_EXPIRED')
    }
  })

  it('rejects an invite with a forged signature', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })
    // Tamper the sig (last segment after final '.')
    const parts = token.split('.')
    const forged = `${parts[0]}.${parts[1]}.AAAA-AAAA-AAAA`

    const { pubB64 } = await freshKeypair()
    const result = await registerHandler({
      install_id: uuidv7(),
      public_key: pubB64,
      invite_token: forged,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_INVITE_INVALID')
    }
  })

  it('rejects malformed registration payload (missing public_key)', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })

    const result = await registerHandler({
      install_id: uuidv7(),
      public_key: '',
      invite_token: token,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_REQUEST_MALFORMED')
    }
  })

  it('rejects a public_key that is not 32 bytes', async () => {
    const { token } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })

    // 16 random bytes (too short for Ed25519)
    const shortKey = bytesToBase64Url(new Uint8Array(16))
    const result = await registerHandler({
      install_id: uuidv7(),
      public_key: shortKey,
      invite_token: token,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('AUTH_REQUEST_MALFORMED')
    }
  })

  it('rejects re-registration of the same install_id', async () => {
    const { token: token1 } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })
    const { pubB64 } = await freshKeypair()
    const installId = uuidv7()

    const r1 = await registerHandler({
      install_id: installId,
      public_key: pubB64,
      invite_token: token1,
    })
    expect(r1.ok).toBe(true)

    const { token: token2 } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'member',
    })
    const r2 = await registerHandler({
      install_id: installId, // SAME install_id, different invite token
      public_key: pubB64,
      invite_token: token2,
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe('AUTH_INVITE_ALREADY_USED')
    }
  })

  it('records role correctly for owner / viewer roles', async () => {
    // owner
    const { token: ownerTok } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'owner',
    })
    const { pubB64: ownerPub } = await freshKeypair()
    const ownerInstall = uuidv7()
    const r1 = await registerHandler({
      install_id: ownerInstall,
      public_key: ownerPub,
      invite_token: ownerTok,
    })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.role).toBe('owner')
    }

    // viewer
    const { token: viewerTok } = mintInvite({
      tenantId: TEST_TENANT_ID,
      role: 'viewer',
    })
    const { pubB64: viewerPub } = await freshKeypair()
    const viewerInstall = uuidv7()
    const r2 = await registerHandler({
      install_id: viewerInstall,
      public_key: viewerPub,
      invite_token: viewerTok,
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.role).toBe('viewer')
    }
  })
})
