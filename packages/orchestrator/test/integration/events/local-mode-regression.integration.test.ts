/**
 * test/integration/events/local-mode-regression.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Regression test: ORBITAL_DEPLOY_TARGET=local (default) must continue using
 * Postgres LISTEN/NOTIFY for event fanout. SNS must NOT be called in local mode.
 *
 * Verifies the local-mode path is unchanged after 8-05 additions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { EventInput, EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSend = vi.fn().mockResolvedValue({ MessageId: 'should-not-be-called' })

vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PublishCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}))

vi.mock('../../../src/hub-client/sanitize.js', () => ({
  sanitizeForHub: vi.fn(),
  LocalDataLeakError: class LocalDataLeakError extends Error {
    constructor(
      public path: string,
      public reason: string,
      public context: string,
    ) {
      super(reason)
    }
  },
}))

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { appendAndPublish, _resetSnsClientForTests, PostgresEventStore } from '../../../src/events/store.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskCreated',
    payload: { tenant_id: 'tenant-local-001', test: true },
    actor: { type: 'system', component: 'regression-test' },
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

function makeStoredEnvelope(input: EventInput): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: input.aggregate_id,
    aggregate_type: input.aggregate_type,
    event_type: input.event_type,
    payload: input.payload,
    actor: input.actor,
    trace_id: input.trace_id,
    occurred_at: input.occurred_at,
    ingested_at: new Date().toISOString(),
    schema_version: input.schema_version,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appendAndPublish — local mode regression (ORBITAL_DEPLOY_TARGET=local)', () => {
  let mockStore: PostgresEventStore

  beforeEach(() => {
    vi.clearAllMocks()
    _resetSnsClientForTests()
    resetEnvCache()

    // Local mode (the default)
    process.env['ORBITAL_DEPLOY_TARGET'] = 'local'
    process.env['NODE_ENV'] = 'test'
    // Remove topic ARN to ensure we don't accidentally use it
    delete process.env['EVENTS_TOPIC_ARN']

    mockStore = {
      append: vi.fn(),
    } as unknown as PostgresEventStore
  })

  afterEach(() => {
    delete process.env['ORBITAL_DEPLOY_TARGET']
    delete process.env['EVENTS_TOPIC_ARN']
    resetEnvCache()
    _resetSnsClientForTests()
  })

  it('does NOT call SNS in local mode', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('still calls store.append() in local mode (local write always runs)', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    expect(mockStore.append).toHaveBeenCalledOnce()
  })

  it('returns the stored envelope in local mode', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    const result = await appendAndPublish(mockStore, input)
    expect(result).toEqual(stored)
  })

  it('local mode works when EVENTS_TOPIC_ARN is absent (no env var required locally)', async () => {
    // Ensure EVENTS_TOPIC_ARN is not set
    expect(process.env['EVENTS_TOPIC_ARN']).toBeUndefined()

    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    // Should not throw even without topic ARN in local mode
    const result = await appendAndPublish(mockStore, input)
    expect(result).toEqual(stored)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('appendAndPublish — unset ORBITAL_DEPLOY_TARGET defaults to local', () => {
  let mockStore: PostgresEventStore

  beforeEach(() => {
    vi.clearAllMocks()
    _resetSnsClientForTests()
    resetEnvCache()

    // Do not set ORBITAL_DEPLOY_TARGET — should default to 'local'
    delete process.env['ORBITAL_DEPLOY_TARGET']
    delete process.env['EVENTS_TOPIC_ARN']
    process.env['NODE_ENV'] = 'test'

    mockStore = {
      append: vi.fn(),
    } as unknown as PostgresEventStore
  })

  afterEach(() => {
    delete process.env['ORBITAL_DEPLOY_TARGET']
    delete process.env['EVENTS_TOPIC_ARN']
    resetEnvCache()
    _resetSnsClientForTests()
  })

  it('defaults to local mode — SNS not called', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    const result = await appendAndPublish(mockStore, input)
    expect(result).toEqual(stored)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
