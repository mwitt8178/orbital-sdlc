/**
 * lambda/consumers/memory-recorder.ts — SQS consumer for Memory* events.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Triggered by SQS queue `orbital-${env}-memory-recorder`.
 * Receives events with event_type IN [MemoryEntryRecorded, MemoryRetrievedForBrief].
 *
 * v1: structured CloudWatch audit log per event.
 * v2 (deferred): write to memory search index.
 *
 * Partial-batch retry: returns { batchItemFailures } so failed records are
 * re-delivered without re-processing successfully handled siblings.
 */

import type { SQSEvent, SQSBatchItemFailure, SQSBatchResponse } from 'aws-lambda'
import { logger } from '../../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Event types handled by this consumer
// ---------------------------------------------------------------------------

const HANDLED_EVENT_TYPES = new Set([
  'MemoryEntryRecorded',
  'MemoryRetrievedForBrief',
])

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Process a single Memory event.
 *
 * v1: structured audit log with tenant_id, event_type, aggregate_id.
 * v2 (deferred): write to memory search index.
 */
async function processMemoryEvent(event: EventEnvelope): Promise<void> {
  if (!HANDLED_EVENT_TYPES.has(event.event_type)) {
    // SNS filter policy should prevent unknown types; log and skip.
    logger.warn(
      { event_type: event.event_type, event_id: event.event_id },
      'memory-recorder: unexpected event_type — skipping',
    )
    return
  }

  const tenantId = extractTenantId(event)

  logger.info(
    {
      event_id: event.event_id,
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
      aggregate_type: event.aggregate_type,
      tenant_id: tenantId,
      occurred_at: event.occurred_at,
      // v2: memory-specific fields to be indexed
      // memory_id: (event.payload as Record<string, unknown>)['memory_id'],
    },
    'memory-recorder: processing memory event',
  )

  // v2 TODO (deferred): write to memory search index
  // await memoryIndex.upsert({ tenantId, event })
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

      await processMemoryEvent(event)
    } catch (err) {
      logger.error(
        { messageId: record.messageId, err },
        'memory-recorder: failed to process record — will retry',
      )
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }

  return { batchItemFailures }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTenantId(event: EventEnvelope): string | undefined {
  const payload = event.payload as Record<string, unknown>
  const tenantId = payload['tenant_id']
  return typeof tenantId === 'string' ? tenantId : undefined
}
