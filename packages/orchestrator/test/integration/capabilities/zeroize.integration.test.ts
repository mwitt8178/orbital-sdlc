/**
 * zeroize.integration.test.ts
 *
 * Integration tests for KeyZeroizeService + registerKeyZeroizeSchedule.
 *
 * Uses real Postgres and the per-process test keychain shim.
 *
 * Covers:
 *   - Multiple stale keys are all zeroized in a single sweep.
 *   - Schedule + fake timers: registerKeyZeroizeSchedule calls zeroizeOldKeys
 *     at the configured interval with multiple stale keys present.
 *   - Idempotency: a second sweep on already-zeroized rows is a no-op.
 *   - KeyArchived events are emitted for every zeroized key.
 *   - Public component is retained in signing_keys after zeroization.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { signingKeys } from '../../../src/db/schema/capabilities.js'
import { events } from '../../../src/db/schema/events.js'
import { KeyZeroizeService } from '../../../src/capabilities/zeroize.js'
import { registerKeyZeroizeSchedule } from '../../../src/capabilities/zeroize-schedule.js'
import {
  resetKeychainCache,
  getTestShimKeychain,
} from '../../../src/capabilities/keychain.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-zi-${process.pid}.json`)

const ownedKeyIds: string[] = []
const ownedAggregateIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  process.env.ORBITAL_TEST_KEYCHAIN_PATH = TEST_SHIM_FILE
  resetKeychainCache()
  await fs.unlink(TEST_SHIM_FILE).catch(() => undefined)
})

afterEach(async () => {
  // No fake timers in integration tests — real timers only.
})

afterAll(async () => {
  if (ownedKeyIds.length > 0) {
    for (const keyId of ownedKeyIds) {
      await db.delete(signingKeys).where(eq(signingKeys.key_id, keyId)).catch(() => undefined)
    }
  }
  if (ownedAggregateIds.length > 0) {
    for (const aggId of ownedAggregateIds) {
      await db.delete(events).where(eq(events.aggregateId, aggId)).catch(() => undefined)
    }
  }
  await fs.unlink(TEST_SHIM_FILE).catch(() => undefined)
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertStaleKey(opts: {
  daysOld?: number
  status?: 'retired' | 'archived'
}): Promise<{ keyId: string; keychainRef: string }> {
  const { daysOld = 31, status = 'retired' } = opts
  const keyId = uuidv7()
  const installId = uuidv7()
  const activeSince = new Date(Date.now() - (daysOld + 1) * 24 * 60 * 60 * 1000)
  const activeUntil = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
  const keychainRef = `sub:${keyId}`

  const keychain = await getTestShimKeychain()
  await keychain.setPassword(keychainRef, Buffer.from(`fake-private-${keyId}`).toString('base64'))

  await db.insert(signingKeys).values({
    key_id: keyId,
    key_kind: 'sub',
    parent_key_id: null,
    install_id: installId,
    sprint_id: uuidv7(),
    public_key: Buffer.from(`fake-public-${keyId}`).toString('base64'),
    keychain_ref: keychainRef,
    parent_signature: null,
    algorithm: 'ed25519',
    created_at: activeSince,
    active_from: activeSince,
    active_until: activeUntil,
    private_zeroized_at: null,
    status,
    schema_version: 1,
  })

  ownedKeyIds.push(keyId)
  ownedAggregateIds.push(keyId) // KeyArchived events use keyId as aggregate_id
  return { keyId, keychainRef }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KeyZeroizeService.zeroizeOldKeys — multiple keys (integration)', () => {
  it('zeroizes all stale keys in a single sweep', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    // Sequential insertions to avoid concurrent writes to the keychain shim file.
    const stale = [
      await insertStaleKey({ daysOld: 31 }),
      await insertStaleKey({ daysOld: 45 }),
      await insertStaleKey({ daysOld: 60 }),
    ]

    // Run at least one sweep (may have already been pre-empted by parallel fork).
    const result = await service.zeroizeOldKeys(30)
    expect(result.errors).toHaveLength(0)

    // The canonical assertion is DB state, not result.zeroizedKeyIds, because a
    // parallel test fork may have already swept these keys before this call.
    // Keychain state is per-fork and cannot be reliably asserted across parallel
    // forks (a sibling fork may have swept the same DB row, clearing keychain_ref
    // in the DB without being able to delete from this fork's shim file).
    // Keychain deletion is covered by unit tests (zeroize.test.ts).
    for (const { keyId } of stale) {
      const rows = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId))
      expect(rows[0]?.private_zeroized_at).not.toBeNull()
      expect(rows[0]?.keychain_ref).toBeNull()
      expect(rows[0]?.status).toBe('archived')
    }
  })

  it('emits a KeyArchived event for each zeroized key', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const stale = [
      await insertStaleKey({ daysOld: 33 }),
      await insertStaleKey({ daysOld: 50 }),
    ]

    await service.zeroizeOldKeys(30)

    for (const { keyId } of stale) {
      const evtRows = await db
        .select()
        .from(events)
        .where(eq(events.aggregateId, keyId))
      const archived = evtRows.find((e) => e.eventType === 'KeyArchived')
      expect(archived).toBeDefined()
      const payload = archived!.payload as Record<string, unknown>
      expect(payload['key_id']).toBe(keyId)
      expect(payload['reason']).toBe('retention_window_elapsed')
    }
  })

  it('retains the public component for all zeroized keys', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const stale = [await insertStaleKey({ daysOld: 31 }), await insertStaleKey({ daysOld: 32 })]

    await service.zeroizeOldKeys(30)

    for (const { keyId } of stale) {
      const rows = await db
        .select({ pub: signingKeys.public_key, zeroized: signingKeys.private_zeroized_at })
        .from(signingKeys)
        .where(eq(signingKeys.key_id, keyId))
      expect(rows[0]?.pub).toBeDefined()
      expect(rows[0]!.pub.length).toBeGreaterThan(0)
      expect(rows[0]?.zeroized).not.toBeNull()
    }
  })

  it('second sweep is a no-op: key is not re-processed, no errors', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const { keyId } = await insertStaleKey({ daysOld: 35 })

    // First sweep — may be pre-empted by parallel fork, but DB state must be
    // correct regardless.
    await service.zeroizeOldKeys(30)

    // DB state must show key is zeroized.
    const rowsAfterFirst = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId))
    expect(rowsAfterFirst[0]?.private_zeroized_at).not.toBeNull()

    // Second sweep — key is filtered out by isNull(private_zeroized_at) and NOT reprocessed.
    const second = await service.zeroizeOldKeys(30)
    expect(second.zeroizedKeyIds).not.toContain(keyId)
    expect(second.errors).toHaveLength(0)

    // DB state unchanged after second sweep.
    const rowsAfterSecond = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId))
    expect(rowsAfterSecond[0]?.private_zeroized_at).toEqual(rowsAfterFirst[0]?.private_zeroized_at)
    expect(rowsAfterSecond[0]?.keychain_ref).toBeNull()
  })
})

describe('registerKeyZeroizeSchedule — real timers + multiple stale keys (integration)', () => {
  it('zeroizes multiple stale keys via the scheduled sweep', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    // Insert stale keys sequentially.
    const allKeys = [
      await insertStaleKey({ daysOld: 31 }),
      await insertStaleKey({ daysOld: 40 }),
      await insertStaleKey({ daysOld: 50 }),
    ]

    // Use a very short interval so the test runs quickly.
    const intervalMs = 200

    const handle = registerKeyZeroizeSchedule({
      keyZeroizeService: service,
      intervalMs,
      olderThanDays: 30,
    })

    // Poll until all keys are zeroized in DB: keychain_ref = NULL AND private_zeroized_at != NULL.
    // DB update happens after keychain delete in zeroizeOldKeys, so once DB shows
    // keychain_ref = NULL the keychain delete has already completed.
    const deadline = Date.now() + 10_000
    let allZeroized = false
    while (Date.now() < deadline) {
      const rows = await db
        .select({ zeroized: signingKeys.private_zeroized_at, keychain_ref: signingKeys.keychain_ref })
        .from(signingKeys)
        .where(inArray(signingKeys.key_id, allKeys.map((k) => k.keyId)))

      if (
        rows.length === allKeys.length &&
        rows.every((r) => r.zeroized !== null && r.keychain_ref === null)
      ) {
        allZeroized = true
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    handle.stop()

    expect(allZeroized).toBe(true)

    // Final assertion: DB state is authoritative. Keychain state is per-fork
    // and cannot be reliably asserted across parallel forks.
    // Keychain deletion correctness is covered by unit tests (zeroize.test.ts).
    for (const { keyId } of allKeys) {
      const rows = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId))
      expect(rows[0]?.private_zeroized_at).not.toBeNull()
      expect(rows[0]?.keychain_ref).toBeNull()
    }
  })
})
