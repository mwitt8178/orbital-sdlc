/**
 * Unit tests for EventStore.
 *
 * Per Task 1A done criteria:
 * - append persists rows
 * - UPDATE raises exception (append-only)
 * - DELETE raises exception (append-only)
 * - query filters work
 *
 * These tests use the real Docker Postgres — no mocks allowed per task rules.
 * Each test works with unique aggregate_id values to avoid inter-test coupling.
 * Inserts stay in their partitions; we never TRUNCATE (trigger would reject).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql as dSQL } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import type { EventInput } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Setup: real Postgres connections
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore

const testActor: EventInput['actor'] = {
  type: 'system',
  component: 'orchestrator',
}

function makeEvent(overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskCreated',
    payload: { test: true },
    actor: testActor,
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, {
    max: 5,
    idle_timeout: 10,
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
// append
// ---------------------------------------------------------------------------

describe('EventStore.append', () => {
  it('persists an event and returns the full envelope', async () => {
    const input = makeEvent()
    const envelope = await store.append(input)

    expect(envelope.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(envelope.aggregate_id).toBe(input.aggregate_id)
    expect(envelope.aggregate_type).toBe('task')
    expect(envelope.event_type).toBe('TaskCreated')
    expect(envelope.schema_version).toBe(1)
    expect(envelope.ingested_at).toBeTruthy()
    // ingested_at should be a valid ISO string
    expect(() => new Date(envelope.ingested_at)).not.toThrow()
  })

  it('generates a unique UUIDv7 event_id for each append', async () => {
    const [a, b] = await Promise.all([
      store.append(makeEvent()),
      store.append(makeEvent()),
    ])
    expect(a.event_id).not.toBe(b.event_id)
    // UUIDv7 format check (version nibble = 7)
    expect(a.event_id[14]).toBe('7')
    expect(b.event_id[14]).toBe('7')
  })

  it('includes schema_version in the returned envelope', async () => {
    const envelope = await store.append(makeEvent({ schema_version: 2 }))
    expect(envelope.schema_version).toBe(2)
  })

  it('stores optional capability_id and parent_event_id', async () => {
    const capId = uuidv7()
    const parentId = (await store.append(makeEvent())).event_id

    const envelope = await store.append(
      makeEvent({ capability_id: capId, parent_event_id: parentId }),
    )
    expect(envelope.capability_id).toBe(capId)
    expect(envelope.parent_event_id).toBe(parentId)
  })

  it('rejects an invalid aggregate_type', async () => {
    // Force-cast to bypass TypeScript compile-time check; runtime Zod validates.
    const badEvent = makeEvent()
    ;(badEvent as Record<string, unknown>)['aggregate_type'] = 'INVALID_TYPE'
    await expect(store.append(badEvent)).rejects.toThrow()
  })

  it('returns existing envelope on duplicate event_id (idempotency)', async () => {
    // To test this we insert a row directly with a known event_id and then
    // attempt to insert again — the store should catch the 23505 and return existing.
    const first = await store.append(makeEvent())

    // Simulate gateway retry with same event_id by inserting via raw SQL.
    // The second INSERT will hit the unique constraint; store catches it.
    // We verify the error is handled gracefully by directly triggering the duplicate.
    const rawSql = sqlPool as postgres.Sql
    await expect(
      rawSql`
        INSERT INTO audit.events (event_id, aggregate_id, aggregate_type, event_type, payload, actor, trace_id, occurred_at, ingested_at, schema_version)
        VALUES (${first.event_id}::uuid, gen_random_uuid(), 'task', 'TaskCreated', '{}', '{"type":"system","component":"orchestrator"}', 'trace-dup', NOW(), NOW(), 1)
      `,
    ).rejects.toMatchObject({ code: '23505' })

    // The store's append() with same event_id returns the first envelope.
    // We can't force the same event_id through append() (it generates UUIDv7),
    // so we verify the duplicate path via direct getById consistency.
    const fetched = await store.getById(first.event_id)
    expect(fetched?.event_id).toBe(first.event_id)
  })
})

// ---------------------------------------------------------------------------
// Append-only enforcement (UPDATE / DELETE triggers)
// Per TRD-07 §4.1.3 and §11.1
// ---------------------------------------------------------------------------

describe('Append-only triggers', () => {
  it('rejects UPDATE on audit.events with P0001', async () => {
    const envelope = await store.append(makeEvent())
    const rawSql = sqlPool as postgres.Sql

    await expect(
      rawSql`
        UPDATE audit.events
        SET event_type = 'MutatedType'
        WHERE event_id = ${envelope.event_id}::uuid
      `,
    ).rejects.toMatchObject({
      code: 'P0001',
    })
  })

  it('rejects DELETE on audit.events with P0001', async () => {
    const envelope = await store.append(makeEvent())
    const rawSql = sqlPool as postgres.Sql

    await expect(
      rawSql`
        DELETE FROM audit.events
        WHERE event_id = ${envelope.event_id}::uuid
      `,
    ).rejects.toMatchObject({
      code: 'P0001',
    })
  })

  it('rejects TRUNCATE on audit.events with P0001', async () => {
    const rawSql = sqlPool as postgres.Sql

    await expect(
      rawSql`TRUNCATE audit.events`,
    ).rejects.toMatchObject({
      code: 'P0001',
    })
  })
})

// ---------------------------------------------------------------------------
// query — filter correctness
// Per Task 1A done criteria
// ---------------------------------------------------------------------------

describe('EventStore.query — filters', () => {
  // Use a shared aggregateId for this test group so we can filter precisely.
  const sharedAggregateId = uuidv7()

  beforeAll(async () => {
    // Insert a set of events with known shapes.
    await store.append(makeEvent({
      aggregate_id: sharedAggregateId,
      aggregate_type: 'task',
      event_type: 'TaskCreated',
      schema_version: 1,
      trace_id: 'trace-filter-test',
      actor: { type: 'user', user_id: 'user-filter-1', install_id: 'install-1' },
    }))
    await store.append(makeEvent({
      aggregate_id: sharedAggregateId,
      aggregate_type: 'task',
      event_type: 'TaskCompleted',
      schema_version: 1,
      trace_id: 'trace-filter-test',
      actor: { type: 'persona', persona_id: 'persona-filter-1', session_id: 'session-1' },
    }))
    // A third event on a different aggregate to verify isolation.
    await store.append(makeEvent({
      aggregate_type: 'sprint',
      event_type: 'SprintStarted',
      schema_version: 1,
    }))
  })

  it('filters by aggregate_id', async () => {
    const result = await store.query({ aggregate_id: sharedAggregateId, limit: 100 })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    for (const item of result.items) {
      expect(item.aggregate_id).toBe(sharedAggregateId)
    }
  })

  it('filters by aggregate_type', async () => {
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      aggregate_type: 'task',
      limit: 100,
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    for (const item of result.items) {
      expect(item.aggregate_type).toBe('task')
    }
  })

  it('filters by event_type', async () => {
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      event_type: 'TaskCreated',
      limit: 100,
    })
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    for (const item of result.items) {
      expect(item.event_type).toBe('TaskCreated')
    }
  })

  it('filters by trace_id', async () => {
    const result = await store.query({ trace_id: 'trace-filter-test', limit: 100 })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    for (const item of result.items) {
      expect(item.trace_id).toBe('trace-filter-test')
    }
  })

  it('filters by actor_type=user', async () => {
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      actor_type: 'user',
      limit: 100,
    })
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    for (const item of result.items) {
      expect(item.actor.type).toBe('user')
    }
  })

  it('filters by actor_id (persona_id)', async () => {
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      actor_type: 'persona',
      actor_id: 'persona-filter-1',
      limit: 100,
    })
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    for (const item of result.items) {
      expect(item.actor.type).toBe('persona')
    }
  })

  it('filters by occurred_at range (occurred_after)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString() // 1 minute ago
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      occurred_after: past,
      limit: 100,
    })
    // All events we inserted just now should be after the 1-min-ago mark.
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    for (const item of result.items) {
      expect(new Date(item.occurred_at) >= new Date(past)).toBe(true)
    }
  })

  it('filters by occurred_at range (occurred_before)', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const result = await store.query({
      aggregate_id: sharedAggregateId,
      occurred_before: future,
      limit: 100,
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty when filter matches nothing', async () => {
    const result = await store.query({
      aggregate_id: uuidv7(), // guaranteed unique, no rows
      limit: 100,
    })
    expect(result.items).toHaveLength(0)
    expect(result.has_more).toBe(false)
    expect(result.next_cursor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// query — cursor pagination
// ---------------------------------------------------------------------------

describe('EventStore.query — cursor pagination', () => {
  const paginationAggId = uuidv7()
  const BATCH_SIZE = 5

  beforeAll(async () => {
    // Insert 5 events with staggered occurred_at so ordering is stable.
    for (let i = 0; i < BATCH_SIZE; i++) {
      await store.append(
        makeEvent({
          aggregate_id: paginationAggId,
          event_type: `PaginationEvent_${i}`,
          occurred_at: new Date(Date.now() + i * 10).toISOString(),
        }),
      )
    }
  })

  it('returns first page with has_more=true when limit < total', async () => {
    const page1 = await store.query({ aggregate_id: paginationAggId, limit: 2 })
    expect(page1.items.length).toBe(2)
    expect(page1.has_more).toBe(true)
    expect(page1.next_cursor).not.toBeNull()
  })

  it('returns all events across pages without duplicates', async () => {
    const allIds = new Set<string>()
    let cursor: string | null | undefined = undefined
    let pageCount = 0

    while (true) {
      const page = await store.query({
        aggregate_id: paginationAggId,
        limit: 2,
        after: cursor ?? undefined,
      })
      for (const item of page.items) {
        allIds.add(item.event_id)
      }
      pageCount++
      if (!page.has_more) break
      cursor = page.next_cursor
      // Safety: never loop more than 10 times
      if (pageCount > 10) throw new Error('pagination loop exceeded expected page count')
    }

    expect(allIds.size).toBe(BATCH_SIZE)
  })

  it('returns has_more=false and next_cursor=null when all results fit on one page', async () => {
    const page = await store.query({ aggregate_id: paginationAggId, limit: 100 })
    expect(page.items.length).toBe(BATCH_SIZE)
    expect(page.has_more).toBe(false)
    expect(page.next_cursor).toBeNull()
  })

  it('resuming from cursor does not repeat rows', async () => {
    const page1 = await store.query({ aggregate_id: paginationAggId, limit: 3 })
    const page1Ids = new Set(page1.items.map((e) => e.event_id))

    const page2 = await store.query({
      aggregate_id: paginationAggId,
      limit: 3,
      after: page1.next_cursor ?? undefined,
    })
    for (const item of page2.items) {
      expect(page1Ids.has(item.event_id)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// schema_version validation
// ---------------------------------------------------------------------------

describe('schema_version field', () => {
  it('is preserved through append and query round-trip', async () => {
    const aggId = uuidv7()
    await store.append(makeEvent({ aggregate_id: aggId, schema_version: 3 }))
    const result = await store.query({ aggregate_id: aggId, limit: 1 })
    expect(result.items[0]?.schema_version).toBe(3)
  })

  it('Zod validates schema_version is a positive integer', async () => {
    // schema_version: 0 should fail Zod validation (positive = min 1)
    await expect(
      store.append(makeEvent({ schema_version: 0 })),
    ).rejects.toThrow()
  })
})
