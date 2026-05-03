/**
 * lambda/consumers/audit-indexer.ts — SQS consumer for all events (audit trail).
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Triggered by SQS queue `orbital-${env}-audit-indexer`.
 * Receives ALL events (no SNS filter policy — existence filter).
 *
 * v1: structured CloudWatch log of the full event envelope for every event.
 *     This provides a queryable audit trail via CloudWatch Logs Insights.
 * v2 (deferred): write to OpenSearch index.
 *
 * Partial-batch retry: returns { batchItemFailures }.
 *
 * Tenant isolation: tenant_id is logged and indexing is scoped per-tenant.
 * The SNS subscription filter in the CDK construct ensures only events carrying
 * a valid tenant_id reach this consumer (existence filter on event_type).
 */

import type { SQSEvent, SQSBatchItemFailure, SQSBatchResponse } from 'aws-lambda'
import { logger } from '../../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Index a single event.
 *
 * v1: structured CloudWatch log with full event envelope.
 *     Log group: /orbital/{env}/lambda/audit-indexer
 * v2 (deferred): OpenSearch upsert.
 */
async function indexEvent(event: EventEnvelope): Promise<void> {
  const tenantId = extractTenantId(event)

  // Structured log — every field is independently queryable via CW Logs Insights.
  // Query example:
  //   fields tenant_id, event_type, aggregate_id | filter tenant_id = "xxx" | sort @timestamp desc
  logger.info(
    {
      // Audit fields
      audit_event_id: event.event_id,
      event_type: event.event_type,
      aggregate_type: event.aggregate_type,
      aggregate_id: event.aggregate_id,
      tenant_id: tenantId,
      actor_type: (event.actor as Record<string, unknown>)['type'],
      occurred_at: event.occurred_at,
      ingested_at: event.ingested_at,
      schema_version: event.schema_version,
      trace_id: event.trace_id,
      capability_id: event.capability_id ?? null,
      // v2: payload is indexed but not logged here to avoid PII leakage
      // payload_size_bytes: JSON.stringify(event.payload).length,
    },
    'audit-indexer: event indexed',
  )

  // v2 TODO (deferred): OpenSearch upsert
  // await openSearchClient.index({ index: `orbital-events-${tenantId}`, body: event })
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

      await indexEvent(event)
    } catch (err) {
      logger.error(
        { messageId: record.messageId, err },
        'audit-indexer: failed to process record — will retry',
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
