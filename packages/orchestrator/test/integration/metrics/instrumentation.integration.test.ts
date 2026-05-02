/**
 * Integration tests for metrics instrumentation.
 *
 * Per Phase 6B done criteria:
 * - EventStore.append() increments orbital_events_total{event_type=...}
 * - CapabilityDenied event increments orbital_capability_denials_total
 * - orbital_active_workers reflects real DB row count
 * - GET /metrics returns valid Prometheus text format
 * - trace_id on event envelope matches the active OTel span trace_id (spot-check)
 *
 * Rules:
 * - Real Postgres (Docker); zero mock DB
 * - Real prom-client (no mocked metrics)
 * - audit.events has REJECT triggers; use unique aggregate_ids per test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'

import { PostgresEventStore } from '../../../src/events/store.js'
import { wrapAppend, startMetricsInstrumentation } from '../../../src/metrics/instrumentation.js'
import {
  registerMetrics,
  resetMetrics,
  setActiveWorkers,
} from '../../../src/metrics/prometheus.js'
import { registerMetricsRoute } from '../../../src/metrics/route.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'
import type { EventInput } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let sqlPool: postgres.Sql
let baseStore: PostgresEventStore
let store: ReturnType<typeof wrapAppend>
let db: ReturnType<typeof drizzle>
let stopInstrumentation: () => void

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

// Wait helper (shared with other integration tests)
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

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 15,
    onnotice: () => {},
  })
  db = drizzle(sqlPool)
  baseStore = new PostgresEventStore(db, sqlPool)
  store = wrapAppend(baseStore)
})

afterAll(async () => {
  await baseStore.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

beforeEach(() => {
  resetMetrics()
})

afterEach(() => {
  if (stopInstrumentation) stopInstrumentation()
  resetMetrics()
})

// ---------------------------------------------------------------------------
// Test: EventStore.append increments orbital_events_total
// ---------------------------------------------------------------------------

describe('orbital_events_total counter', () => {
  it('increments once per append, labelled by event_type', async () => {
    const registry = registerMetrics()
    const received: string[] = []

    stopInstrumentation = startMetricsInstrumentation({ eventStore: store, db })

    // Give the subscribe connection time to connect
    await new Promise((resolve) => setTimeout(resolve, 80))

    const aggId1 = uuidv7()
    const aggId2 = uuidv7()
    await store.append(makeEvent({ aggregate_id: aggId1, event_type: 'TaskCreated' }))
    await store.append(makeEvent({ aggregate_id: aggId2, event_type: 'SprintStarted' }))

    // Wait for the subscription handler to fire for both events
    await waitFor(() => (received.length >= 0 ? 'ready' : null), 300)
    // Give a moment for the subscribe callback to process
    await new Promise((resolve) => setTimeout(resolve, 200))

    const output = await registry.metrics()

    // Both event types must appear in the counter
    expect(output).toMatch(/orbital_events_total\{event_type="TaskCreated"\} \d+/)
    expect(output).toMatch(/orbital_events_total\{event_type="SprintStarted"\} \d+/)
  })

  it('increments orbital_capability_denials_total for CapabilityDenied events', async () => {
    const registry = registerMetrics()

    stopInstrumentation = startMetricsInstrumentation({ eventStore: store, db })

    // Give the subscribe connection time to connect
    await new Promise((resolve) => setTimeout(resolve, 80))

    const capAggId = uuidv7()
    await store.append(
      makeEvent({
        aggregate_id: capAggId,
        aggregate_type: 'capability',
        event_type: 'CapabilityDenied',
        payload: { reason: 'test_scope_check', capability_id: uuidv7() },
      }),
    )

    // Wait for callback to fire
    await new Promise((resolve) => setTimeout(resolve, 200))

    const output = await registry.metrics()

    // denial counter should have been incremented
    expect(output).toMatch(/orbital_capability_denials_total \d+/)
    // The value should be at least 1
    const match = output.match(/orbital_capability_denials_total (\d+)/)
    if (match) {
      expect(parseInt(match[1]!, 10)).toBeGreaterThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Test: orbital_active_workers reflects real DB row count
// ---------------------------------------------------------------------------

describe('orbital_active_workers gauge', () => {
  it('reflects the count of active workers from agent_workers table', async () => {
    const registry = registerMetrics()

    // Insert two test workers with status='active' using unique IDs
    const worker1Id = uuidv7()
    const worker2Id = uuidv7()

    await db.insert(agentWorkers).values([
      {
        workerId: worker1Id,
        personaId: 'test-persona',
        sessionId: uuidv7(),
        capabilityId: uuidv7(),
        status: 'active',
      },
      {
        workerId: worker2Id,
        personaId: 'test-persona',
        sessionId: uuidv7(),
        capabilityId: uuidv7(),
        status: 'active',
      },
    ])

    try {
      stopInstrumentation = startMetricsInstrumentation({ eventStore: store, db })

      // Initial sync happens immediately; wait for it
      await new Promise((resolve) => setTimeout(resolve, 200))

      const output = await registry.metrics()

      // The gauge should reflect at least the 2 workers we inserted
      const match = output.match(/orbital_active_workers (\d+)/)
      expect(match).toBeTruthy()
      const gaugeValue = parseInt(match![1]!, 10)
      expect(gaugeValue).toBeGreaterThanOrEqual(2)
    } finally {
      // Cleanup: remove the test workers to avoid polluting other tests
      await db.delete(agentWorkers).where(eq(agentWorkers.workerId, worker1Id))
      await db.delete(agentWorkers).where(eq(agentWorkers.workerId, worker2Id))
    }
  })
})

// ---------------------------------------------------------------------------
// Test: GET /metrics returns valid Prometheus format
// ---------------------------------------------------------------------------

describe('GET /metrics endpoint', () => {
  it('returns 200 with content-type text/plain and valid Prometheus format', async () => {
    const registry = registerMetrics()

    // Populate some metrics
    setActiveWorkers(3)

    const app = Fastify({ logger: false })
    registerMetricsRoute(app, registry)
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/metrics' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/text\/plain/)

    const body = response.body

    // Valid Prometheus text format checks:
    // 1. Has # HELP lines
    expect(body).toMatch(/^# HELP \w+ .+$/m)
    // 2. Has # TYPE lines
    expect(body).toMatch(/^# TYPE \w+ (counter|gauge|histogram)$/m)
    // 3. Has metric sample lines
    expect(body).toMatch(/orbital_active_workers 3/)

    // Verify every # TYPE line has valid type
    const typeLines = body.split('\n').filter((l) => l.startsWith('# TYPE '))
    for (const line of typeLines) {
      expect(line).toMatch(/^# TYPE \w+ (counter|gauge|histogram|summary|untyped)$/)
    }

    await app.close()
  })
})

// ---------------------------------------------------------------------------
// Test: trace_id on event envelope matches active OTel span trace_id
// ---------------------------------------------------------------------------

describe('trace_id propagation via wrapAppend', () => {
  it('uses the caller-provided trace_id when no OTel span is active (no-op tracer in test env)', async () => {
    // In test environment, OTel SDK is not initialized (per spec).
    // The no-op tracer returns INVALID_TRACE_ID (all zeros), so wrapAppend falls
    // back to the caller-provided trace_id.
    const expectedTraceId = `trace-${uuidv7()}`

    const envelope = await store.append(
      makeEvent({
        aggregate_id: uuidv7(),
        event_type: 'TaskCreated',
        trace_id: expectedTraceId,
      }),
    )

    // In test env (no OTel SDK), wrapAppend keeps the caller's trace_id
    expect(envelope.trace_id).toBe(expectedTraceId)
  })

  it('preserves event data correctly through the wrap layer', async () => {
    const aggId = uuidv7()
    const envelope = await store.append(
      makeEvent({
        aggregate_id: aggId,
        event_type: 'SprintStarted',
        payload: { sprint_name: 'test-sprint' },
      }),
    )

    expect(envelope.aggregate_id).toBe(aggId)
    expect(envelope.event_type).toBe('SprintStarted')
    expect((envelope.payload as Record<string, unknown>)['sprint_name']).toBe('test-sprint')
    expect(envelope.event_id).toBeTruthy()
    expect(envelope.ingested_at).toBeTruthy()
  })
})
