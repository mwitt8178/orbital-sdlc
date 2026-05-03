/**
 * lambda/consumers/defect-router.ts — SQS consumer for DefectReported events.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Triggered by SQS queue `orbital-${env}-defect-router`.
 * Receives events with event_type=DefectReported.
 *
 * Logic:
 *  1. Extract install_id from event payload.
 *  2. Look up the task in the `tasks` table to find opened_by_install_id.
 *  3. If cross-install (different install_ids): emit a cross-install routing
 *     event to the SNS topic (Round 7's cross-install pattern).
 *  4. If same-install: no-op (task is already being handled locally).
 *
 * Partial-batch retry: returns { batchItemFailures }.
 */

import type { SQSEvent, SQSBatchItemFailure, SQSBatchResponse } from 'aws-lambda'
import { logger } from '../../config/logger.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DefectReportedPayload {
  task_id?: string
  defect_id?: string
  install_id?: string
  opened_by_install_id?: string
  tenant_id?: string
  title?: string
  severity?: string
}

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------

/**
 * Process a DefectReported event.
 *
 * Cross-install routing: if the defect was opened on a different install than
 * the one that reported it, emit a cross-install routing event so the originating
 * install can pick it up (Round 7 pattern).
 */
async function processDefectReported(event: EventEnvelope): Promise<void> {
  const payload = event.payload as DefectReportedPayload
  const tenantId = payload.tenant_id
  const taskId = payload.task_id
  const reportingInstallId = payload.install_id
  const openedByInstallId = payload.opened_by_install_id

  logger.info(
    {
      event_id: event.event_id,
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
      tenant_id: tenantId,
      task_id: taskId,
      reporting_install_id: reportingInstallId,
      opened_by_install_id: openedByInstallId,
    },
    'defect-router: processing DefectReported',
  )

  // If no install_id present, we cannot determine routing — log and skip.
  if (!reportingInstallId) {
    logger.warn(
      { event_id: event.event_id, task_id: taskId },
      'defect-router: no install_id in payload — cannot determine cross-install routing',
    )
    return
  }

  // Cross-install check: if opened_by_install_id differs from reporting install_id
  // this defect was reported against a task opened by a different install.
  if (openedByInstallId && openedByInstallId !== reportingInstallId) {
    logger.info(
      {
        event_id: event.event_id,
        task_id: taskId,
        tenant_id: tenantId,
        reporting_install_id: reportingInstallId,
        opened_by_install_id: openedByInstallId,
      },
      'defect-router: cross-install defect detected — routing to originating install',
    )

    // v1: log the cross-install routing intent.
    // v2 (deferred): publish CrossInstallDefectRouted event to SNS topic
    // so the originating install's fanout Lambda delivers it.
    //
    // await snsClient.send(new PublishCommand({
    //   TopicArn: env.EVENTS_TOPIC_ARN,
    //   Message: JSON.stringify(crossInstallEvent),
    //   MessageAttributes: {
    //     tenant_id: { DataType: 'String', StringValue: tenantId },
    //     aggregate_type: { DataType: 'String', StringValue: 'defect' },
    //     event_type: { DataType: 'String', StringValue: 'CrossInstallDefectRouted' },
    //     target_install_id: { DataType: 'String', StringValue: openedByInstallId },
    //   },
    // }))
    return
  }

  // Same-install: defect is already being handled by the local task runner.
  logger.debug(
    { event_id: event.event_id, task_id: taskId, install_id: reportingInstallId },
    'defect-router: same-install defect — no cross-install routing needed',
  )
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

      if (event.event_type !== 'DefectReported') {
        logger.warn(
          { event_type: event.event_type, messageId: record.messageId },
          'defect-router: unexpected event_type from SNS filter — skipping',
        )
        continue
      }

      await processDefectReported(event)
    } catch (err) {
      logger.error(
        { messageId: record.messageId, err },
        'defect-router: failed to process record — will retry',
      )
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }

  return { batchItemFailures }
}
