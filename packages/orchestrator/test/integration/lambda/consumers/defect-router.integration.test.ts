/**
 * test/integration/lambda/consumers/defect-router.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { SQSEvent } from 'aws-lambda'
import { handler } from '../../../../src/lambda/consumers/defect-router.js'
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
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:orbital-mwitt-defect-router',
    awsRegion: 'us-east-1',
  }
}

function makeDefectEvent(overrides: Partial<{ install_id: string; opened_by_install_id: string; task_id: string; tenant_id: string }> = {}): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: uuidv7(),
    aggregate_type: 'defect',
    event_type: 'DefectReported',
    payload: {
      tenant_id: overrides.tenant_id ?? 'tenant-defect-001',
      task_id: overrides.task_id ?? uuidv7(),
      defect_id: uuidv7(),
      install_id: overrides.install_id ?? 'install-A',
      opened_by_install_id: overrides.opened_by_install_id ?? 'install-A',
      title: 'Test defect',
      severity: 'medium',
    },
    actor: { type: 'system', component: 'defect-service' },
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

describe('defect-router handler', () => {
  it('processes same-install DefectReported without error (no-op routing)', async () => {
    const event = makeDefectEvent({ install_id: 'install-A', opened_by_install_id: 'install-A' })
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('processes cross-install DefectReported without error (logs routing intent)', async () => {
    const event = makeDefectEvent({ install_id: 'install-B', opened_by_install_id: 'install-A' })
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('handles missing install_id gracefully (warns, no failure)', async () => {
    const event = makeDefectEvent()
    // Remove install_id from payload
    const payload = event.payload as Record<string, unknown>
    delete payload['install_id']
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('skips records with unexpected event_type (warns, no failure)', async () => {
    const event = makeDefectEvent()
    const wrongTypeEvent = { ...event, event_type: 'TaskCreated' } as EventEnvelope
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(wrongTypeEvent)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('returns partial-batch failure for malformed JSON', async () => {
    const sqsEvent: SQSEvent = {
      Records: [{
        messageId: 'bad-msg',
        receiptHandle: 'r',
        body: '{invalid}',
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
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-msg')
  })

  it('processes a batch of mixed same-install and cross-install defects', async () => {
    const events = [
      makeDefectEvent({ install_id: 'install-A', opened_by_install_id: 'install-A' }),
      makeDefectEvent({ install_id: 'install-B', opened_by_install_id: 'install-A' }),
      makeDefectEvent({ install_id: 'install-C', opened_by_install_id: 'install-C' }),
    ]
    const sqsEvent: SQSEvent = { Records: events.map((e) => makeSqsRecord(e)) }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })
})
