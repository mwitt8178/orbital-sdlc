/**
 * Unit tests for KeyZeroizeService and registerKeyZeroizeSchedule.
 *
 * Uses a test DB (real Postgres) for zeroize.test.ts — the service queries
 * signing_keys which requires schema access. The schedule helper is tested
 * with fake timers and a stub service.
 *
 * For zeroizeOldKeys:
 *   - Inserts a signing_key row with active_until = 31 days ago, no private_zeroized_at.
 *   - Inserts a keychain entry via the test shim.
 *   - Calls zeroizeOldKeys.
 *   - Asserts private_zeroized_at is set, keychain_ref is NULL, KeyArchived emitted.
 *
 * For registerKeyZeroizeSchedule:
 *   - Fake timers, stub service.
 *   - Verifies zeroizeOldKeys is called at the configured interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq, isNull } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { signingKeys } from '../../../src/db/schema/capabilities.js'
import { KeyZeroizeService } from '../../../src/capabilities/zeroize.js'
import {
  registerKeyZeroizeSchedule,
  type ZeroizableService,
} from '../../../src/capabilities/zeroize-schedule.js'
import {
  resetKeychainCache,
  getTestShimKeychain,
} from '../../../src/capabilities/keychain.js'
import { events } from '../../../src/db/schema/events.js'

// ---------------------------------------------------------------------------
// Test keychain shim setup
// ---------------------------------------------------------------------------

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-zeroize-${process.pid}.json`)

// We own these signing_key rows — cleaned up in afterAll.
const ownedKeyIds: string[] = []
const ownedEventAggregateIds: string[] = []

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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(async () => {
  // Clean up owned rows.
  if (ownedKeyIds.length > 0) {
    for (const keyId of ownedKeyIds) {
      await db.delete(signingKeys).where(eq(signingKeys.key_id, keyId)).catch(() => undefined)
    }
  }
  if (ownedEventAggregateIds.length > 0) {
    for (const aggId of ownedEventAggregateIds) {
      await db
        .delete(events)
        .where(eq(events.aggregateId, aggId))
        .catch(() => undefined)
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
  withKeychainRef?: boolean
  status?: 'retired' | 'archived' | 'active'
}): Promise<string> {
  const {
    daysOld = 31,
    withKeychainRef = true,
    status = 'retired',
  } = opts

  const keyId = uuidv7()
  const installId = uuidv7()
  const activeSince = new Date(Date.now() - (daysOld + 1) * 24 * 60 * 60 * 1000)
  const activeUntil = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
  const keychainRef = withKeychainRef ? `sub:${keyId}` : null

  if (keychainRef) {
    const keychain = await getTestShimKeychain()
    await keychain.setPassword(keychainRef, Buffer.from('fake-private-bytes').toString('base64'))
  }

  await db.insert(signingKeys).values({
    key_id: keyId,
    key_kind: 'sub',
    parent_key_id: null,
    install_id: installId,
    sprint_id: uuidv7(),
    public_key: Buffer.from('fake-public-bytes').toString('base64'),
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
  return keyId
}

// ---------------------------------------------------------------------------
// KeyZeroizeService unit tests (real DB, real keychain shim)
// ---------------------------------------------------------------------------

describe('KeyZeroizeService.zeroizeOldKeys', () => {
  it('zeroizes a stale retired key: sets private_zeroized_at, clears keychain_ref', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = await insertStaleKey({ daysOld: 31, withKeychainRef: true, status: 'retired' })
    ownedEventAggregateIds.push(keyId)

    const result = await service.zeroizeOldKeys(30)

    expect(result.zeroizedCount).toBeGreaterThanOrEqual(1)
    expect(result.zeroizedKeyIds).toContain(keyId)
    expect(result.errors).toHaveLength(0)

    // DB row should now have private_zeroized_at set and keychain_ref null.
    const rows = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.key_id, keyId))
    const row = rows[0]
    expect(row).toBeDefined()
    expect(row!.private_zeroized_at).not.toBeNull()
    expect(row!.keychain_ref).toBeNull()
    expect(row!.status).toBe('archived')

    // Keychain entry should be gone.
    const keychain = await getTestShimKeychain()
    const entry = await keychain.getPassword(`sub:${keyId}`)
    expect(entry).toBeNull()
  })

  it('emits a KeyArchived event with reason retention_window_elapsed', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = await insertStaleKey({ daysOld: 35, status: 'retired' })
    ownedEventAggregateIds.push(keyId)

    await service.zeroizeOldKeys(30)

    // Query for KeyArchived event for this keyId.
    const evtRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, keyId))

    const archivedEvt = evtRows.find((e) => e.eventType === 'KeyArchived')
    expect(archivedEvt).toBeDefined()
    const payload = archivedEvt!.payload as Record<string, unknown>
    expect(payload['key_id']).toBe(keyId)
    expect(payload['reason']).toBe('retention_window_elapsed')
    expect(typeof payload['zeroized_at']).toBe('string')
  })

  it('is idempotent: running twice on the same key does not error', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = await insertStaleKey({ daysOld: 31, status: 'retired' })
    ownedEventAggregateIds.push(keyId)

    const first = await service.zeroizeOldKeys(30)
    expect(first.zeroizedKeyIds).toContain(keyId)

    // Second run — row now has private_zeroized_at; should be excluded by query.
    const second = await service.zeroizeOldKeys(30)
    expect(second.zeroizedKeyIds).not.toContain(keyId)
    expect(second.errors).toHaveLength(0)
  })

  it('does NOT zeroize a key that is within the retention window', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    // 10 days old — within the 30-day window.
    const keyId = await insertStaleKey({ daysOld: 10, status: 'retired' })

    const result = await service.zeroizeOldKeys(30)
    expect(result.zeroizedKeyIds).not.toContain(keyId)
  })

  it('does NOT zeroize an active key', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    // Insert with status=active and active_until=null (active keys have no active_until).
    const keyId = uuidv7()
    const installId = uuidv7()
    const now = new Date()
    await db.insert(signingKeys).values({
      key_id: keyId,
      key_kind: 'sub',
      parent_key_id: null,
      install_id: installId,
      sprint_id: uuidv7(),
      public_key: 'fake-pub',
      keychain_ref: `sub:${keyId}`,
      parent_signature: null,
      algorithm: 'ed25519',
      created_at: now,
      active_from: now,
      active_until: null, // still active — no active_until
      private_zeroized_at: null,
      status: 'active',
      schema_version: 1,
    })
    ownedKeyIds.push(keyId)

    const result = await service.zeroizeOldKeys(30)
    expect(result.zeroizedKeyIds).not.toContain(keyId)
  })

  it('returns zero zeroizedCount when no candidates exist', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    // Fresh service — no stale keys with matching criteria in this run.
    // We ensure by looking for keys older than 999 days.
    const result = await service.zeroizeOldKeys(999)
    expect(result.zeroizedCount).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('verifies that the public component is retained after zeroization', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = await insertStaleKey({ daysOld: 31, status: 'retired' })
    ownedEventAggregateIds.push(keyId)

    await service.zeroizeOldKeys(30)

    const rows = await db
      .select({ public_key: signingKeys.public_key })
      .from(signingKeys)
      .where(eq(signingKeys.key_id, keyId))

    expect(rows[0]?.public_key).toBeDefined()
    expect(rows[0]!.public_key.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// registerKeyZeroizeSchedule unit tests (fake timers + stub service)
// ---------------------------------------------------------------------------

describe('registerKeyZeroizeSchedule', () => {
  const makeStubZeroizeService = (): {
    service: ZeroizableService
    zeroizeSpy: ReturnType<typeof vi.fn>
  } => {
    const zeroizeSpy = vi.fn().mockResolvedValue({
      zeroizedCount: 0,
      zeroizedKeyIds: [],
      errors: [],
    })
    return {
      service: { zeroizeOldKeys: zeroizeSpy },
      zeroizeSpy,
    }
  }

  it('calls zeroizeOldKeys once immediately at startup', async () => {
    vi.useFakeTimers()
    const { service, zeroizeSpy } = makeStubZeroizeService()

    registerKeyZeroizeSchedule({ keyZeroizeService: service, intervalMs: 1000 })

    // The initial call is async (fire-and-forget); advance microtasks.
    await vi.waitFor(() => expect(zeroizeSpy).toHaveBeenCalledTimes(1))

    vi.useRealTimers()
  })

  it('calls zeroizeOldKeys at each interval', async () => {
    vi.useFakeTimers()
    const { service, zeroizeSpy } = makeStubZeroizeService()
    const intervalMs = 5_000

    registerKeyZeroizeSchedule({ keyZeroizeService: service, intervalMs })

    // Wait for the initial startup call.
    await vi.waitFor(() => expect(zeroizeSpy).toHaveBeenCalledTimes(1))

    // Advance past one interval — should trigger the periodic call.
    vi.advanceTimersByTime(intervalMs + 1)
    await Promise.resolve()
    expect(zeroizeSpy).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(intervalMs)
    await Promise.resolve()
    expect(zeroizeSpy).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('stop() prevents further calls', async () => {
    vi.useFakeTimers()
    const { service, zeroizeSpy } = makeStubZeroizeService()
    const intervalMs = 2_000

    const handle = registerKeyZeroizeSchedule({ keyZeroizeService: service, intervalMs })

    await vi.waitFor(() => expect(zeroizeSpy).toHaveBeenCalledTimes(1))

    handle.stop()

    vi.advanceTimersByTime(intervalMs * 10)
    await Promise.resolve()
    // Only the startup call — no interval calls after stop().
    expect(zeroizeSpy).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('passes olderThanDays to zeroizeOldKeys', async () => {
    vi.useFakeTimers()
    const { service, zeroizeSpy } = makeStubZeroizeService()

    registerKeyZeroizeSchedule({
      keyZeroizeService: service,
      intervalMs: 1000,
      olderThanDays: 60,
    })

    await vi.waitFor(() => expect(zeroizeSpy).toHaveBeenCalled())
    expect(zeroizeSpy).toHaveBeenCalledWith(60)

    vi.useRealTimers()
  })

  it('does not throw when zeroizeOldKeys rejects', async () => {
    vi.useFakeTimers()
    const { service, zeroizeSpy } = makeStubZeroizeService()
    zeroizeSpy.mockRejectedValue(new Error('db error'))

    await expect(async () => {
      registerKeyZeroizeSchedule({ keyZeroizeService: service, intervalMs: 500 })
      await new Promise((r) => setTimeout(r, 10))
    }).not.toThrow()

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Supplemental: verify isNull filter works correctly in query
// ---------------------------------------------------------------------------

describe('KeyZeroizeService.zeroizeOldKeys — already-zeroized rows are skipped', () => {
  it('skips rows with private_zeroized_at already set', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = uuidv7()
    const installId = uuidv7()
    const pastDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const zeroizedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

    await db.insert(signingKeys).values({
      key_id: keyId,
      key_kind: 'sub',
      parent_key_id: null,
      install_id: installId,
      sprint_id: uuidv7(),
      public_key: 'fake-pub-already-zeroized',
      keychain_ref: null, // already removed
      parent_signature: null,
      algorithm: 'ed25519',
      created_at: pastDate,
      active_from: pastDate,
      active_until: pastDate,
      private_zeroized_at: zeroizedAt, // already done
      status: 'archived',
      schema_version: 1,
    })
    ownedKeyIds.push(keyId)

    const result = await service.zeroizeOldKeys(30)
    expect(result.zeroizedKeyIds).not.toContain(keyId)
  })

  it('verifies signing_keys table still has the row after zeroization (public retained)', async () => {
    const eventStore = createEventStore(db, sql)
    const service = new KeyZeroizeService(eventStore, db)

    const keyId = await insertStaleKey({ daysOld: 31, status: 'retired' })
    ownedEventAggregateIds.push(keyId)

    await service.zeroizeOldKeys(30)

    // Row still exists.
    const rows = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId))
    expect(rows).toHaveLength(1)
    // Private zeroized.
    expect(rows[0]!.private_zeroized_at).not.toBeNull()
    // keychain_ref cleared.
    expect(rows[0]!.keychain_ref).toBeNull()
    // Public component retained.
    expect(rows[0]!.public_key).toBeDefined()
    expect(rows[0]!.public_key.length).toBeGreaterThan(0)
    // isNull check confirms the DB state for any re-query.
    const notYetZeroized = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.key_id, keyId))
      .then((rs) => rs.filter((r) => r.private_zeroized_at === null))
    expect(notYetZeroized).toHaveLength(0)
  })
})
