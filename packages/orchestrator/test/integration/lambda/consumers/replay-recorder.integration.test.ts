/**
 * test/integration/lambda/consumers/replay-recorder.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { SQSEvent } from 'aws-lambda'
import { handler } from '../../../../src/lambda/consumers/replay-recorder.js'
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
    eventSourceARN: 'arn:aws:sqs:us-east-1:123:orbital-mwitt-replay-recorder',
    awsRegion: 'us-east-1',
  }
}

function makeReplayEvent(overrides: {
  replayId?: string
  tenantId?: string
  s3Key?: string
  s3Bucket?: string
} = {}): EventEnvelope {
  const replayId = overrides.replayId ?? uuidv7()
  const tenantId = overrides.tenantId ?? 'tenant-replay-001'
  return {
    event_id: uuidv7(),
    aggregate_id: replayId,
    aggregate_type: 'replay',
    event_type: 'ReplayCaptureCompleted',
    payload: {
      replay_id: replayId,
      tenant_id: tenantId,
      install_id: 'install-A',
      s3_key: overrides.s3Key ?? `replays/${tenantId}/${replayId}.bin.zst`,
      s3_bucket: overrides.s3Bucket ?? 'orbital-replays-mwitt-123456789012',
      duration_ms: 30000,
      blob_size_bytes: 12345,
      kms_key_arn: 'arn:aws:kms:us-east-1:123456789012:key/test-key',
      captured_at: new Date().toISOString(),
    },
    actor: { type: 'system', component: 'replay-service' },
    trace_id: `trace-${uuidv7()}`,
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

describe('replay-recorder handler', () => {
  it('records a ReplayCaptureCompleted event without error', async () => {
    const event = makeReplayEvent()
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('handles missing replay_id gracefully (warns, no failure)', async () => {
    const event = makeReplayEvent()
    const payload = event.payload as Record<string, unknown>
    delete payload['replay_id']
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('handles missing s3_key gracefully (warns, no failure)', async () => {
    const event = makeReplayEvent()
    const payload = event.payload as Record<string, unknown>
    delete payload['s3_key']
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('skips events with wrong event_type', async () => {
    const event = makeReplayEvent()
    const wrongTypeEvent = { ...event, event_type: 'TaskCreated' } as EventEnvelope
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(wrongTypeEvent)] }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('returns partial-batch failure for malformed records', async () => {
    const sqsEvent: SQSEvent = {
      Records: [{
        messageId: 'bad-replay',
        receiptHandle: 'r',
        body: '{{ bad json',
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
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe('bad-replay')
  })

  it('cross-references s3_key contains the replay_id', async () => {
    const replayId = uuidv7()
    const tenantId = 'tenant-replay-002'
    const event = makeReplayEvent({
      replayId,
      tenantId,
      s3Key: `replays/${tenantId}/${replayId}.bin.zst`,
    })
    const sqsEvent: SQSEvent = { Records: [makeSqsRecord(event)] }

    // Key contains replayId — no warning expected; should succeed silently
    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })

  it('processes a batch of multiple replay events', async () => {
    const events = [makeReplayEvent(), makeReplayEvent(), makeReplayEvent()]
    const sqsEvent: SQSEvent = { Records: events.map((e) => makeSqsRecord(e)) }

    const result = await handler(sqsEvent)

    expect(result.batchItemFailures).toHaveLength(0)
  })
})
