/**
 * lambda/consumers/replay-recorder.ts — SQS consumer for ReplayCaptureCompleted events.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Triggered by SQS queue `orbital-${env}-replay-recorder`.
 * Receives events with event_type=ReplayCaptureCompleted.
 *
 * v1: Cross-reference the S3 blob key from the event payload and write
 *     metadata to CloudWatch for fast lookup by replay_id / tenant_id.
 * v2 (deferred): write metadata to a DynamoDB or OpenSearch index for
 *     sub-100ms replay lookup by replay_id.
 *
 * Partial-batch retry: returns { batchItemFailures }.
 */

import type { SQSEvent, SQSBatchItemFailure, SQSBatchResponse } from 'aws-lambda'
import { logger } from '../../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplayCaptureCompletedPayload {
  replay_id?: string
  install_id?: string
  tenant_id?: string
  /** S3 key of the replay blob in the replay bucket. */
  s3_key?: string
  /** S3 bucket name (should match ORBITAL_REPLAY_BUCKET env var). */
  s3_bucket?: string
  /** Duration of the captured session in milliseconds. */
  duration_ms?: number
  /** Size of the compressed replay blob in bytes. */
  blob_size_bytes?: number
  /** KMS key ARN used to encrypt the blob (per-tenant CMK or default key). */
  kms_key_arn?: string
  captured_at?: string
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Record replay capture metadata.
 *
 * v1: structured CloudWatch log for lookup via Logs Insights.
 *     Query example:
 *       fields replay_id, s3_key, tenant_id | filter replay_id = "xxx"
 * v2 (deferred): write to DynamoDB index for O(1) lookup by replay_id.
 */
async function recordReplayCapture(event: EventEnvelope): Promise<void> {
  const payload = event.payload as ReplayCaptureCompletedPayload

  const replayId = payload.replay_id
  const tenantId = payload.tenant_id
  const s3Key = payload.s3_key
  const s3Bucket = payload.s3_bucket

  if (!replayId || !s3Key) {
    logger.warn(
      { event_id: event.event_id, payload_keys: Object.keys(payload) },
      'replay-recorder: missing replay_id or s3_key in payload — cannot record metadata',
    )
    return
  }

  // Cross-reference: confirm the S3 blob key matches expected pattern
  // Pattern: replays/{tenant_id}/{replay_id}.bin.zst (from replay/store.ts S3Store)
  const expectedPattern = tenantId
    ? `replays/${tenantId}/${replayId}`
    : `replays/${replayId}`

  const keyMatchesPattern = s3Key.includes(replayId)
  if (!keyMatchesPattern) {
    logger.warn(
      { replay_id: replayId, s3_key: s3Key, expected_pattern: expectedPattern },
      'replay-recorder: S3 key does not match expected pattern — recording anyway',
    )
  }

  logger.info(
    {
      // Replay metadata — queryable via CW Logs Insights
      replay_id: replayId,
      tenant_id: tenantId,
      install_id: payload.install_id,
      s3_key: s3Key,
      s3_bucket: s3Bucket,
      duration_ms: payload.duration_ms,
      blob_size_bytes: payload.blob_size_bytes,
      kms_key_arn: payload.kms_key_arn,
      captured_at: payload.captured_at ?? event.occurred_at,
      event_id: event.event_id,
      ingested_at: event.ingested_at,
    },
    'replay-recorder: replay capture recorded',
  )

  // v2 TODO (deferred): write to DynamoDB metadata table
  // await ddbClient.send(new PutItemCommand({
  //   TableName: process.env['REPLAY_METADATA_TABLE'],
  //   Item: {
  //     replay_id: { S: replayId },
  //     tenant_id: { S: tenantId ?? 'unknown' },
  //     s3_key: { S: s3Key },
  //     s3_bucket: { S: s3Bucket ?? '' },
  //     captured_at: { S: payload.captured_at ?? event.occurred_at },
  //     ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) }, // 90d TTL
  //   },
  //   ConditionExpression: 'attribute_not_exists(replay_id)',
  // }))
}

// ---------------------------------------------------------------------------
// SQS handler — partial-batch retry
// ---------------------------------------------------------------------------

export const handler = async (sqsEvent: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = []

  for (const record of sqsEvent.Records) {
    try {
      const snsWrapper = JSON.parse(record.body) as { Message: string }
      const event = JSON.parse(snsWrapper.Message) as EventEnvelope

      if (event.event_type !== 'ReplayCaptureCompleted') {
        logger.warn(
          { event_type: event.event_type, messageId: record.messageId },
          'replay-recorder: unexpected event_type from SNS filter — skipping',
        )
        continue
      }

      await recordReplayCapture(event)
    } catch (err) {
      logger.error(
        { messageId: record.messageId, err },
        'replay-recorder: failed to process record — will retry',
      )
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }

  return { batchItemFailures }
}
