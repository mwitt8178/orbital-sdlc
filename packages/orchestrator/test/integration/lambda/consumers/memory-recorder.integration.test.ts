/**
 * test/integration/lambda/consumers/memory-recorder.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Tests for the memory-recorder SQS consumer Lambda.
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { SQSEvent } from 'aws-lambda'
import { handler } from '../../../../src/lambda/consumers/memory-recorder.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsEvent(events: EventEnvelope[]): SQSEvent {
  return {
    Records: events.map((event, i) => ({
      messageId: `msg-${i}-${uuidv7()}`,
      receiptHandle: `receipt-${i}`,
      body: JSON.stringify({ Message: JSON.stringify(event) }),
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: String(Date.now()),
        SenderId: 'AIDAI23456789012345678',
        ApproximateFirstReceiveTimestamp: String(Date.now()),
      },
      messageAttributes: {},
      md5OfBody: 'md5',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:orbital-mwitt-memory-recorder',
      awsRegion: 'us-east-1',
    })),
  }
}

function makeMemoryEvent(eventType: 'MemoryEntryRecorded' | 'MemoryRetrievedForBrief' = 'MemoryEntryRecorded'): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: uuidv7(),
    aggregate_type: 'memory',
    event_type: eventType,
    payload: {
      tenant_id: 'tenant-memory-test-001',
      memory_id: uuidv7(),
      content_summary: 'test memory entry',
    },
    actor: { type: 'system', component: 'memory-service' },
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory-recorder handler', () => {
  it('processes MemoryEntryRecorded events without error', async () => {
    const event = makeMemoryEvent('MemoryEntryRecorded')
    const sqsEvent = makeSqsEvent([event])

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('processes MemoryRetrievedForBrief events without error', async () => {
    const event = makeMemoryEvent('MemoryRetrievedForBrief')
    const sqsEvent = makeSqsEvent([event])

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('processes a batch of multiple memory events', async () => {
    const events = [
      makeMemoryEvent('MemoryEntryRecorded'),
      makeMemoryEvent('MemoryRetrievedForBrief'),
      makeMemoryEvent('MemoryEntryRecorded'),
    ]
    const sqsEvent = makeSqsEvent(events)

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('returns partial-batch failure for malformed JSON records', async () => {
    const sqsEvent: SQSEvent = {
      Records: [
        {
          messageId: 'bad-msg-1',
          receiptHandle: 'receipt',
          body: 'NOT VALID JSON {{{',
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: String(Date.now()),
            SenderId: 'test',
            ApproximateFirstReceiveTimestamp: String(Date.now()),
          },
          messageAttributes: {},
          md5OfBody: 'md5',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
          awsRegion: 'us-east-1',
        },
      ],
    }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(1)
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-msg-1')
  })

  it('handles unknown event_type gracefully (logs warning, no failure)', async () => {
    const unknownEvent: EventEnvelope = {
      ...makeMemoryEvent(),
      event_type: 'UnknownMemoryEvent',
    }
    const sqsEvent = makeSqsEvent([unknownEvent])

    const result = await handler(sqsEvent)

    // Should not fail — just logs a warning and skips
    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('continues processing valid records after a bad record (partial batch)', async () => {
    const sqsEvent: SQSEvent = {
      Records: [
        {
          messageId: 'bad-msg',
          receiptHandle: 'r1',
          body: '{{{invalid json',
          attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()), SenderId: 's', ApproximateFirstReceiveTimestamp: String(Date.now()) },
          messageAttributes: {},
          md5OfBody: 'md5',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:us-east-1:123:q',
          awsRegion: 'us-east-1',
        },
        {
          messageId: 'good-msg',
          receiptHandle: 'r2',
          body: JSON.stringify({ Message: JSON.stringify(makeMemoryEvent()) }),
          attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()), SenderId: 's', ApproximateFirstReceiveTimestamp: String(Date.now()) },
          messageAttributes: {},
          md5OfBody: 'md5',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn:aws:sqs:us-east-1:123:q',
          awsRegion: 'us-east-1',
        },
      ],
    }

    const result = await handler(sqsEvent)

    // Only the bad record should fail; good record should succeed
    expect(result.batchItemFailures).toHaveLength(1)
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-msg')
  })
})
