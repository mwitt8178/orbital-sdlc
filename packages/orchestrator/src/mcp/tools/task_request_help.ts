/**
 * MCP tool: task.request_help
 *
 * Per Implementation Plan §6 Task 2B and TRD-04 §6.2.
 *
 * Input:
 *   task_id:      string (UUID)
 *   blocker_kind: string (e.g. 'unclear_requirement', 'file_conflict', 'external_dependency')
 *   description:  string
 *
 * Effects:
 *   - Generates a blocker_id (UUIDv7).
 *   - Emits BlockerRaised event via EventStore.
 *   - Returns blocker_id in the response.
 *
 * Phase 3A (Comms Substrate) will wire the BlockerService routing logic.
 * For Phase 2B: just emit the event.
 *
 * bypassScopeCheck: true — internal system tool; bundle validity checked at
 * connect-time.
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import type { MCPTool, ToolContext } from '../registry.js'
import type { EventInput, Actor } from '@orbital/types'
import { logger } from '../../config/logger.js'

const TaskRequestHelpInputSchema = z.object({
  task_id: z.string().uuid(),
  blocker_kind: z.string().min(1),
  description: z.string().min(1),
})

const TaskRequestHelpOutputSchema = z.object({
  blocker_id: z.string().uuid(),
  event_id: z.string(),
  raised_at: z.string().datetime(),
})

export const taskRequestHelpTool: MCPTool<
  typeof TaskRequestHelpInputSchema,
  typeof TaskRequestHelpOutputSchema
> = {
  name: 'task.request_help',
  description:
    'Raise a blocker for the current task. Emits BlockerRaised. Phase 3A wires routing to a resolver persona.',
  inputSchema: TaskRequestHelpInputSchema,
  outputSchema: TaskRequestHelpOutputSchema,
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    const { task_id, blocker_kind, description } = input
    const { eventStore, bundle, traceId } = ctx

    const blockerId = uuidv7()
    const raisedAt = new Date().toISOString()

    const actor: Actor = {
      type: 'persona',
      persona_id: bundle.persona_id,
      session_id: bundle.session_id,
      task_id: bundle.task_id,
    }

    const ev: EventInput = {
      aggregate_id: blockerId,
      aggregate_type: 'orchestration',
      event_type: 'BlockerRaised',
      payload: {
        blocker_id: blockerId,
        task_id,
        worker_id: bundle.session_id,
        blocker_kind,
        description,
        // Phase 3A will populate resolver_persona_id, channel_id.
        resolver_persona_id: null,
        channel_id: null,
      },
      actor,
      capability_id: bundle.capability_id,
      trace_id: traceId,
      occurred_at: raisedAt,
      schema_version: 1,
    }

    const envelope = await eventStore.append(ev)

    logger.info(
      { task_id, blocker_id: blockerId, blocker_kind, worker_id: bundle.session_id },
      'task.request_help: BlockerRaised emitted',
    )

    return {
      blocker_id: blockerId,
      event_id: envelope.event_id,
      raised_at: raisedAt,
    }
  },
}
