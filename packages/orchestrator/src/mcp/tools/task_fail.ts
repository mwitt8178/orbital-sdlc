/**
 * MCP tool: task.fail
 *
 * Per Implementation Plan §6 Task 2B and TRD-04 §6.2.
 *
 * Input:
 *   task_id:      string (UUID)
 *   error_code:   string (SCREAMING_SNAKE_CASE error code)
 *   error_message: string
 *   retry_advice:  'retry_now' | 'retry_with_backoff' | 'no_retry' | 'escalate_to_human'
 *
 * Effects:
 *   - Emits TaskFailed event via EventStore.
 *   - Phase 2C will wire task state → 'failed' and retry policy.
 *
 * bypassScopeCheck: true — internal system tool.
 */

import { z } from 'zod'
import type { MCPTool, ToolContext } from '../registry.js'
import type { EventInput, Actor } from '@orbital/types'
import { logger } from '../../config/logger.js'

const TaskFailInputSchema = z.object({
  task_id: z.string().uuid(),
  error_code: z.string().min(1),
  error_message: z.string().min(1),
  retry_advice: z
    .enum(['retry_now', 'retry_with_backoff', 'no_retry', 'escalate_to_human'])
    .default('retry_with_backoff'),
})

const TaskFailOutputSchema = z.object({
  task_id: z.string().uuid(),
  event_id: z.string(),
  failed_at: z.string().datetime(),
})

export const taskFailTool: MCPTool<
  typeof TaskFailInputSchema,
  typeof TaskFailOutputSchema
> = {
  name: 'task.fail',
  description:
    'Report task failure. Emits TaskFailed event. Phase 2C wires retry/escalation logic.',
  inputSchema: TaskFailInputSchema,
  outputSchema: TaskFailOutputSchema,
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    const { task_id, error_code, error_message, retry_advice } = input
    const { eventStore, bundle, traceId } = ctx

    const failedAt = new Date().toISOString()

    const actor: Actor = {
      type: 'persona',
      persona_id: bundle.persona_id,
      session_id: bundle.session_id,
      task_id: bundle.task_id,
    }

    const ev: EventInput = {
      aggregate_id: task_id,
      aggregate_type: 'task',
      event_type: 'TaskFailed',
      payload: {
        task_id,
        worker_id: bundle.session_id,
        error_code,
        error_detail: error_message,
        // attempt_number: Phase 2C will fill from retry_attempts table.
        attempt_number: 1,
        retry_eligible: retry_advice !== 'no_retry',
        retry_advice,
      },
      actor,
      capability_id: bundle.capability_id,
      trace_id: traceId,
      occurred_at: failedAt,
      schema_version: 1,
    }

    const envelope = await eventStore.append(ev)

    logger.warn(
      { task_id, error_code, worker_id: bundle.session_id, retry_advice },
      'task.fail: TaskFailed emitted',
    )

    return {
      task_id,
      event_id: envelope.event_id,
      failed_at: failedAt,
    }
  },
}
