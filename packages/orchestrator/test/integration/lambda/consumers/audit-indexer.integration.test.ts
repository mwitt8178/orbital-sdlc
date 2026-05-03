/**
 * test/integration/lambda/consumers/audit-indexer.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { SQSEvent } from 'aws-lambda'
import { handler } from '../../../../src/lambda/consumers/audit-indexer.js'
import type { EventEnvelope } from '@orbital/types'

function makeSqsRecord(event: EventEnvelope, messageId = uuidv7()) {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body: JSON.stringify({ Message: JSON.stringify(event) }),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: String(Date.now()),
      SenderId: 'test',
      ApproximateFirstReceiveTimestamp: String(Date.now()),
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:orbital-mwitt-audit-indexer',
    awsRegion: 'us-east-1',
  }
}

function makeEvent(eventType = 'TaskCreated', tenantId = 'tenant-audit-001'): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: eventType,
    payload: { tenant_id: tenantId, test: true },
    actor: { type: 'user', user_id: uuidv7() },
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

describe('audit-indexer handler', () => {
  it('indexes any event without error', async () => {
    const event = makeEvent('TaskCreated')
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('indexes different event types from multiple domains', async () => {
    const events = [
      makeEvent('TaskCreated'),
      makeEvent('MemoryEntryRecorded'),
      makeEvent('DefectReported'),
      makeEvent('ReplayCaptureCompleted'),
      makeEvent('SprintPlanningStarted'),
    ]
    const sqsEvent: SQSEvent = { Records: events.map((e) => makeSqsRecord(e)) }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('handles events with no tenant_id in payload (logs undefined tenant_id)', async () => {
    const event = makeEvent('TaskCreated')
    const payload = event.payload as Record<string, unknown>
    delete payload['tenant_id']
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('returns partial-batch failure for malformed records', async () => {
    const sqsEvent: SQSEvent = {
      Records: [{
        messageId: 'bad-audit',
        receiptHandle: 'r',
        body: 'NOT JSON',
        attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()), SenderId: 's', ApproximateFirstReceiveTimestamp: String(Date.now()) },
        messageAttributes: {},
        md5OfBody: 'md5',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123:q',
        awsRegion: 'us-east-1',
      }],
    }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(1)
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-audit')
  })

  it('processes events for different tenants independently', async () => {
    const events = [
      makeEvent('TaskCreated', 'tenant-A'),
      makeEvent('TaskCreated', 'tenant-B'),
      makeEvent('TaskCreated', 'tenant-C'),
    ]
    const sqsEvent: SQSEvent = { Records: events.map((e) => makeSqsRecord(e)) }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })
})
