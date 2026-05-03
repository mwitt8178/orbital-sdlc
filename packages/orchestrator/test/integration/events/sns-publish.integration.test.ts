/**
 * test/integration/events/sns-publish.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Tests that appendAndPublish() publishes to SNS with correct message attributes
 * when ORBITAL_DEPLOY_TARGET=aws.
 *
 * Uses a mocked SNS client (vi.mock) — no real AWS account required.
 * The local DB write path is also mocked to isolate the SNS behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { EventInput, EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We mock the SNS client to capture publish calls without needing AWS.
const mockSend = vi.fn().mockResolvedValue({ MessageId: 'test-message-id-123' })

vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PublishCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}))

// Mock the sanitize module to always pass in these tests
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
// Imports AFTER mocks are registered
// ---------------------------------------------------------------------------

import { appendAndPublish, _resetSnsClientForTests, PostgresEventStore } from '../../../src/events/store.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEventInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskCreated',
    payload: {
      tenant_id: 'tenant-abc-123',
      integration_test: true,
    },
    actor: { type: 'system', component: 'test' },
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

describe('appendAndPublish — AWS mode SNS publish', () => {
  let mockStore: PostgresEventStore

  beforeEach(() => {
    vi.clearAllMocks()
    _resetSnsClientForTests()
    resetEnvCache()

    // Set up env for AWS mode
    process.env['ORBITAL_DEPLOY_TARGET'] = 'aws'
    process.env['EVENTS_TOPIC_ARN'] = 'arn:aws:sns:us-east-1:123456789012:orbital-events-mwitt'
    process.env['NODE_ENV'] = 'test'

    // Stub PostgresEventStore.append()
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

  it('calls store.append() and then publishes to SNS', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    const result = await appendAndPublish(mockStore, input)

    expect(result).toEqual(stored)
    expect(mockStore.append).toHaveBeenCalledOnce()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('publishes to the correct TopicArn from EVENTS_TOPIC_ARN env var', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    const [publishCmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    expect(publishCmd.input['TopicArn']).toBe(
      'arn:aws:sns:us-east-1:123456789012:orbital-events-mwitt',
    )
  })

  it('includes tenant_id message attribute from event payload', async () => {
    const tenantId = 'tenant-xyz-789'
    const input = makeEventInput({ payload: { tenant_id: tenantId } })
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    const [publishCmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    const attrs = publishCmd.input['MessageAttributes'] as Record<string, { DataType: string; StringValue: string }>
    expect(attrs['tenant_id']).toEqual({ DataType: 'String', StringValue: tenantId })
  })

  it('includes aggregate_type message attribute', async () => {
    const input = makeEventInput({ aggregate_type: 'defect' })
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    const [publishCmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    const attrs = publishCmd.input['MessageAttributes'] as Record<string, { DataType: string; StringValue: string }>
    expect(attrs['aggregate_type']).toEqual({ DataType: 'String', StringValue: 'defect' })
  })

  it('includes event_type message attribute', async () => {
    const input = makeEventInput({ event_type: 'DefectReported' })
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    const [publishCmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    const attrs = publishCmd.input['MessageAttributes'] as Record<string, { DataType: string; StringValue: string }>
    expect(attrs['event_type']).toEqual({ DataType: 'String', StringValue: 'DefectReported' })
  })

  it('includes the serialized EventEnvelope as the Message body', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    await appendAndPublish(mockStore, input)

    const [publishCmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }]
    const message = JSON.parse(publishCmd.input['Message'] as string) as EventEnvelope
    expect(message.event_id).toBe(stored.event_id)
    expect(message.event_type).toBe(stored.event_type)
  })

  it('does NOT throw if SNS publish fails — local write is authoritative', async () => {
    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)
    mockSend.mockRejectedValueOnce(new Error('SNS throttled'))

    // Should resolve with the stored envelope (local write succeeded)
    const result = await appendAndPublish(mockStore, input)
    expect(result).toEqual(stored)
  })

  it('skips SNS publish when EVENTS_TOPIC_ARN is not set', async () => {
    delete process.env['EVENTS_TOPIC_ARN']
    resetEnvCache()

    const input = makeEventInput()
    const stored = makeStoredEnvelope(input)
    vi.mocked(mockStore.append).mockResolvedValue(stored)

    const result = await appendAndPublish(mockStore, input)
    expect(result).toEqual(stored)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
