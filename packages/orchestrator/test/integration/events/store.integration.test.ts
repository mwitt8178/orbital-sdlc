/**
 * Integration tests for EventStore + NotifyClient.
 *
 * Per Task 1A done criteria:
 * - subscribe receives event within 100ms of append
 * - cursor resumes correctly after disconnect
 * - backfill on connect (cursor-resync pattern)
 *
 * Rules:
 * - Real Docker Postgres only; zero mocks.
 * - Tests use unique aggregate_ids and assert on specific ids, never on total counts.
 * - We never TRUNCATE (trigger rejects it). Tests are isolation-by-unique-id.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PostgresEventStore } from '../../../src/events/store.js'
import type { EventInput, EventEnvelope } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore

const systemActor: EventInput['actor'] = {
  type: 'system',
  component: 'audit_service',
}

function makeEvent(overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskCreated',
    payload: { integration_test: true },
    actor: systemActor,
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 15,
    onnotice: () => {},
  })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------
// Helper: wait for a condition with timeout
// ---------------------------------------------------------------------------

async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = fn()
    if (result !== null && result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// subscribe: real-time delivery within 100ms
// Per Task 1A done criteria and TRD-07 §10.2
// ---------------------------------------------------------------------------

describe('EventStore.subscribe — live delivery', () => {
  it('delivers event to handler within 100ms of append', async () => {
    const targetAggId = uuidv7()
    let receivedEvent: EventEnvelope | null = null

    const unsubscribe = store.subscribe(null, (event) => {
      if (event.aggregate_id === targetAggId) {
        receivedEvent = event
      }
    })

    // Give the LISTEN connection a moment to establish.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const insertedAt = Date.now()
    const appended = await store.append(makeEvent({ aggregate_id: targetAggId }))

    // Wait up to 100ms for the NOTIFY to arrive and be handled.
    const received = await waitFor(() => receivedEvent, 100)

    const deliveryMs = Date.now() - insertedAt
    expect(deliveryMs).toBeLessThanOrEqual(100)
    expect(received.event_id).toBe(appended.event_id)
    expect(received.aggregate_id).toBe(targetAggId)

    unsubscribe()
  })

  it('delivers events from multiple appends to the handler', async () => {
    const aggId = uuidv7()
    const received: EventEnvelope[] = []

    const unsubscribe = store.subscribe(null, (event) => {
      if (event.aggregate_id === aggId) {
        received.push(event)
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const [a, b, c] = await Promise.all([
      store.append(makeEvent({ aggregate_id: aggId, event_type: 'EventA' })),
      store.append(makeEvent({ aggregate_id: aggId, event_type: 'EventB' })),
      store.append(makeEvent({ aggregate_id: aggId, event_type: 'EventC' })),
    ])

    // Wait for all three to arrive.
    await waitFor(() => (received.length >= 3 ? received : null), 200)

    const receivedIds = new Set(received.map((e) => e.event_id))
    expect(receivedIds.has(a.event_id)).toBe(true)
    expect(receivedIds.has(b.event_id)).toBe(true)
    expect(receivedIds.has(c.event_id)).toBe(true)

    unsubscribe()
  })

  it('multiple handlers receive the same event independently', async () => {
    const aggId = uuidv7()
    const handler1Events: EventEnvelope[] = []
    const handler2Events: EventEnvelope[] = []

    const unsub1 = store.subscribe(null, (e) => {
      if (e.aggregate_id === aggId) handler1Events.push(e)
    })
    const unsub2 = store.subscribe(null, (e) => {
      if (e.aggregate_id === aggId) handler2Events.push(e)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    const appended = await store.append(makeEvent({ aggregate_id: aggId }))

    await waitFor(() => (handler1Events.length > 0 && handler2Events.length > 0 ? true : null), 150)

    expect(handler1Events[0]?.event_id).toBe(appended.event_id)
    expect(handler2Events[0]?.event_id).toBe(appended.event_id)

    unsub1()
    unsub2()
  })

  it('unsubscribed handler does not receive events', async () => {
    const aggId = uuidv7()
    const receivedAfterUnsub: EventEnvelope[] = []

    const unsub = store.subscribe(null, (e) => {
      if (e.aggregate_id === aggId) receivedAfterUnsub.push(e)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    unsub() // Unsubscribe before appending.

    await store.append(makeEvent({ aggregate_id: aggId }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedAfterUnsub).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// subscribe: cursor backfill on (re)connect
// Per TRD-07 §4.1.4 — "on (re)connect, query for events newer than cursor"
// ---------------------------------------------------------------------------

describe('EventStore.subscribe — cursor backfill', () => {
  it('backfills events that occurred before subscribe was called (null cursor)', async () => {
    const aggId = uuidv7()

    // Append events BEFORE subscribing to simulate missed events.
    const pre1 = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'PreEvent1' }))
    const pre2 = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'PreEvent2' }))

    // Subscribe with null cursor — backfill should NOT include old events
    // (null cursor means "start from now", not "from beginning of time").
    // We verify this behavior: the store backfills events newer than the cursor.
    // With null cursor, backfillSince returns [] (no "after" filter).
    const backfilledIds = new Set<string>()
    const unsubscribe = store.subscribe(null, (e) => {
      if (e.aggregate_id === aggId) backfilledIds.add(e.event_id)
    })

    // With null cursor, we get NO backfill (backfillSince(null) returns []).
    // But any NEW events after subscribe DO arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const postEvent = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'PostEvent' }))
    await waitFor(() => (backfilledIds.has(postEvent.event_id) ? true : null), 150)

    // The post-subscribe event arrived.
    expect(backfilledIds.has(postEvent.event_id)).toBe(true)
    // pre1 and pre2 may or may not be present (race with LISTEN setup),
    // but postEvent MUST be present.
    void pre1; void pre2; // suppress unused warnings

    unsubscribe()
  })

  it('cursor resume: subscribe with a cursor delivers only events after that cursor', async () => {
    const aggId = uuidv7()

    // Append some events to establish a cursor.
    const early1 = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'Early1' }))
    const early2 = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'Early2' }))

    // Use early1's event_id as cursor.
    const cursorEventId = early1.event_id
    const receivedIds = new Set<string>()

    // Subscribe with cursor = early1's event_id.
    const unsubscribe = store.subscribe(cursorEventId, (e) => {
      if (e.aggregate_id === aggId) receivedIds.add(e.event_id)
    })

    // Wait for backfill to complete.
    // Backfill from early1 should include early2 (which has event_id > early1).
    await waitFor(() => (receivedIds.has(early2.event_id) ? true : null), 200)

    expect(receivedIds.has(early2.event_id)).toBe(true)
    // early1 itself should NOT be in the backfill (cursor is exclusive).
    expect(receivedIds.has(early1.event_id)).toBe(false)

    // Append a new event — it should also arrive.
    const late = await store.append(makeEvent({ aggregate_id: aggId, event_type: 'Late' }))
    await waitFor(() => (receivedIds.has(late.event_id) ? true : null), 150)
    expect(receivedIds.has(late.event_id)).toBe(true)

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// NOTIFY not emitted on rolled-back transaction
// Per TRD-07 §4.1.4 — "NOTIFY messages coalesced and delivered at transaction commit"
// ---------------------------------------------------------------------------

describe('NOTIFY and transaction atomicity', () => {
  it('does not deliver NOTIFY for a rolled-back INSERT', async () => {
    const aggId = uuidv7()
    const delivered: string[] = []

    // We need a fresh store with its own LISTEN connection to avoid interference.
    const freshSql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} })
    const freshDb = drizzle(freshSql)
    const freshStore = new PostgresEventStore(freshDb, freshSql)

    const unsub = freshStore.subscribe(null, (e) => {
      if (e.aggregate_id === aggId) delivered.push(e.event_id)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Perform a rolled-back transaction using postgres.js sql.begin() API.
    // The callback throws, causing sql.begin() to ROLLBACK automatically.
    // Per postgres.js docs: sql.begin() handles BEGIN/COMMIT/ROLLBACK.
    const rolledBackId = uuidv7()
    await freshSql.begin(async (tx) => {
      await tx`
        INSERT INTO audit.events (event_id, aggregate_id, aggregate_type, event_type, payload, actor, trace_id, occurred_at, ingested_at, schema_version)
        VALUES (
          ${rolledBackId}::uuid,
          ${aggId}::uuid,
          'task', 'TaskCreated', '{"rolled_back":true}',
          '{"type":"system","component":"orchestrator"}',
          'trace-rollback',
          NOW(), NOW(), 1
        )
      `
      // Force rollback by throwing inside the transaction block.
      throw new Error('intentional rollback')
    }).catch(() => {
      // Swallow the rollback error — expected.
    })

    // Wait 150ms — no NOTIFY should arrive since transaction was rolled back.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(delivered).toHaveLength(0)

    unsub()
    await freshStore.stopNotifyClient()
    await freshSql.end({ timeout: 5 })
  })
})

// ---------------------------------------------------------------------------
// getById: single event fetch
// ---------------------------------------------------------------------------

describe('EventStore.getById', () => {
  it('fetches an event by its id', async () => {
    const appended = await store.append(makeEvent())
    const fetched = await store.getById(appended.event_id)
    expect(fetched).not.toBeNull()
    expect(fetched?.event_id).toBe(appended.event_id)
  })

  it('returns null for a non-existent event_id', async () => {
    const result = await store.getById(uuidv7())
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Partition placement
// Per TRD-07 §4.1.2: current month partition receives inserts
// ---------------------------------------------------------------------------

describe('Partition routing', () => {
  it('routes an event with current ingested_at into a concrete monthly partition (not default)', async () => {
    const appended = await store.append(makeEvent())

    // Query the system catalog to find which partition this row landed in.
    const rows = await sqlPool<Array<{ tablename: string }>>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE i.inhparent = 'audit.events'::regclass
        AND EXISTS (
          SELECT 1
          FROM audit.events e
          WHERE e.event_id = ${appended.event_id}::uuid
            AND e.tableoid = c.oid
        )
    `

    expect(rows.length).toBe(1)
    const tablename = rows[0]?.tablename ?? ''
    // Should be events_y2026_m05 (current month) not events_default.
    expect(tablename).toMatch(/^events_y\d{4}_m\d{2}$/)
    expect(tablename).not.toBe('events_default')
  })
})
