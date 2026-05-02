/**
 * Integration test: local write succeeds even when hub is down.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * AC 1 + AC 5: With hub down, local write succeeds + outbox row created.
 *
 * Test scenario:
 *   1. Set up local Postgres DB (real connection).
 *   2. Create a mock hub client that always returns { ok: false, status: 503 }.
 *   3. Call appendWithOutboxFallback() — this should:
 *      a. Write the event to the local events table.
 *      b. Enqueue the event to the local_outbox table.
 *   4. Assert both rows exist.
 *
 * No mock in src/. Test helpers only here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

import { PostgresEventStore, appendWithOutboxFallback } from '../../../src/events/store.js'
import { createPersistentHubOutbox } from '../../../src/hub-client/outbox.js'
import { localOutbox } from '../../../src/db/schema/local-outbox.js'
import type { EventInput } from '../../../src/events/types.js'
import type { HubClient } from '../../../src/hub-client/client.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

// Note: no global beforeEach flush — tests clean up their own rows to avoid
// cross-file parallel execution conflicts.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hub client that always reports 503 (hub is down). */
function makeOfflineHubClient(): HubClient {
  return {
    get status() {
      return {
        status: 'error' as const,
        lastSyncAt: null,
        hubUrl: 'http://hub-offline.test',
        errorMessage: 'connection refused',
      }
    },
    get connectionState() {
      return 'offline' as const
    },
    setConnectionStateSource(_fn: unknown) { /* no-op */ },
    tasks: {
      list: async () => ({ ok: false, status: 503, message: 'hub offline' }),
      get: async () => ({ ok: false, status: 503, message: 'hub offline' }),
      claim: async () => ({ ok: false, status: 503, message: 'hub offline' }),
      updateState: async () => ({ ok: false, status: 503, message: 'hub offline' }),
    },
    events: {
      append: async () => ({ ok: false, status: 503, message: 'hub offline' }),
    },
    workers: {
      register: async () => ({ ok: false, status: 503, message: 'hub offline' }),
      updateState: async () => ({ ok: false, status: 503, message: 'hub offline' }),
    },
    query: async () => ({ ok: false, status: 503, message: 'hub offline' }),
    mutate: async () => ({ ok: false, status: 503, message: 'hub offline' }),
    ping: async () => false,
  }
}

function makeEvent(tenantId: string, overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'OfflineWriteTest',
    payload: { tenant_id: tenantId, test: true },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: `trace-offline-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('local-write-persists: hub offline write flow', () => {
  it('LW1: local event write succeeds when hub is offline', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000000'
    const db = drizzle(sqlPool)
    const hubClient = makeOfflineHubClient()
    const outbox = createPersistentHubOutbox(db, hubClient, () => 'offline')

    const event = makeEvent(tenantId)
    const envelope = await appendWithOutboxFallback(store, event, hubClient, outbox)

    // Local write succeeded — we have an event_id
    expect(envelope.event_id).toBeTruthy()
    expect(envelope.event_type).toBe('OfflineWriteTest')
  })

  it('LW2: outbox row is created when hub is offline', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000000'
    const db = drizzle(sqlPool)
    const hubClient = makeOfflineHubClient()
    const outbox = createPersistentHubOutbox(db, hubClient, () => 'offline')

    const event = makeEvent(tenantId)
    const envelope = await appendWithOutboxFallback(store, event, hubClient, outbox)

    // Outbox row created
    const rows = await db
      .select()
      .from(localOutbox)
      .where(isNull(localOutbox.flushed_at))

    const row = rows.find(
      (r) =>
        r.kind === 'event' &&
        (r.payload as Record<string, unknown>)['event_type'] === 'OfflineWriteTest' &&
        (r.payload as Record<string, unknown>)['aggregate_id'] === envelope.aggregate_id,
    )

    expect(row).toBeDefined()
    expect(row?.flushed_at).toBeNull()
    expect(row?.idempotency_key).toBeTruthy()

    // Cleanup: mark as flushed so we don't pollute other tests
    if (row?.seq) {
      await outbox.dismiss(row.seq)
    }
  })

  it('LW3: local write does not block when appendWithOutboxFallback is called', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000000'
    const db = drizzle(sqlPool)
    const hubClient = makeOfflineHubClient()
    const outbox = createPersistentHubOutbox(db, hubClient, () => 'offline')

    const start = Date.now()
    const event = makeEvent(tenantId)
    await appendWithOutboxFallback(store, event, hubClient, outbox)
    const elapsed = Date.now() - start

    // Should complete in well under 5s (no network I/O when offline)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('LW4: multiple offline writes queue in order', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000000'
    const db = drizzle(sqlPool)
    const hubClient = makeOfflineHubClient()
    const outbox = createPersistentHubOutbox(db, hubClient, () => 'offline')

    const events = [makeEvent(tenantId), makeEvent(tenantId), makeEvent(tenantId)]
    const envelopes = await Promise.all(
      events.map((e) => appendWithOutboxFallback(store, e, hubClient, outbox)),
    )

    // All should succeed locally
    expect(envelopes).toHaveLength(3)
    for (const env of envelopes) {
      expect(env.event_id).toBeTruthy()
    }

    // Outbox rows exist and are ordered (seq is ascending)
    const rows = await db
      .select()
      .from(localOutbox)
      .where(isNull(localOutbox.flushed_at))

    const testRows = rows.filter((r) =>
      envelopes.some(
        (e) => (r.payload as Record<string, unknown>)['aggregate_id'] === e.aggregate_id,
      ),
    )

    expect(testRows).toHaveLength(3)
    // Seq ordering preserved
    const seqs = testRows.map((r) => r.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    }

    // Cleanup
    for (const row of testRows) {
      await outbox.dismiss(row.seq)
    }
  })

  it('LW5: hub null (local-only mode) — no outbox row created', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000000'
    const event = makeEvent(tenantId)

    const before = await drizzle(sqlPool)
      .select()
      .from(localOutbox)
      .where(isNull(localOutbox.flushed_at))
    const countBefore = before.length

    const envelope = await appendWithOutboxFallback(store, event, null, null)

    expect(envelope.event_id).toBeTruthy()

    const after = await drizzle(sqlPool)
      .select()
      .from(localOutbox)
      .where(isNull(localOutbox.flushed_at))

    // No new outbox rows
    expect(after.length).toBe(countBefore)
  })
})
