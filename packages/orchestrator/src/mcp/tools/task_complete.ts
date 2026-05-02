/**
 * MCP tool: task.complete
 *
 * Per Implementation Plan §6 Task 2B and TRD-04 §6.2.
 *
 * Input:
 *   task_id:    string (UUID)
 *   summary:    string
 *   artifacts?: {type: string, id: string}[]
 *
 * Effects:
 *   - Emits TaskCompleted event via EventStore.
 *   - Phase 2C will wire actual task table updates (task.state → 'done').
 *     For 2B: event is written; table update is a Phase 2C concern.
 *
 * bypassScopeCheck: true — internal system tool; bundle validity checked at
 * connect-time; no specific resource scope needed.
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import type { MCPTool, ToolContext } from '../registry.js'
import type { EventInput, Actor } from '@orbital/types'
import { logger } from '../../config/logger.js'

const TaskCompleteInputSchema = z.object({
  task_id: z.string().uuid(),
  summary: z.string().min(1),
  artifacts: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
      }),
    )
    .optional()
    .default([]),
})

const TaskCompleteOutputSchema = z.object({
  task_id: z.string().uuid(),
  event_id: z.string(),
  completed_at: z.string().datetime(),
})

export const taskCompleteTool: MCPTool<
  typeof TaskCompleteInputSchema,
  typeof TaskCompleteOutputSchema
> = {
  name: 'task.complete',
  description:
    'Mark the current task as completed. Emits TaskCompleted event. Phase 2C wires task state update.',
  inputSchema: TaskCompleteInputSchema,
  outputSchema: TaskCompleteOutputSchema,
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    const { task_id, summary, artifacts } = input
    const { eventStore, bundle, traceId } = ctx

    const completedAt = new Date().toISOString()

    const actor: Actor = {
      type: 'persona',
      persona_id: bundle.persona_id,
      session_id: bundle.session_id,
      task_id: bundle.task_id,
    }

    const ev: EventInput = {
      aggregate_id: task_id,
      aggregate_type: 'task',
      event_type: 'TaskCompleted',
      payload: {
        task_id,
        worker_id: bundle.session_id,
        output_summary: summary,
        artifact_refs: artifacts ?? [],
        // tokens_consumed and duration_ms will be filled by Phase 2C when it
        // has access to the task table row. For Phase 2B we emit with placeholders.
        tokens_consumed: 0,
        duration_ms: 0,
      },
      actor,
      capability_id: bundle.capability_id,
      trace_id: traceId,
      occurred_at: completedAt,
      schema_version: 1,
    }

    const envelope = await eventStore.append(ev)

    logger.info({ task_id, worker_id: bundle.session_id }, 'task.complete: TaskCompleted emitted')

    return {
      task_id,
      event_id: envelope.event_id,
      completed_at: completedAt,
    }
  },
}
