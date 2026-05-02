/**
 * MCP tool: worker.heartbeat
 *
 * Per Implementation Plan §6 Task 2B and TRD-04 §6.2.
 *
 * Input:
 *   worker_id: string (UUID)
 *   task_id:   string (UUID, optional)
 *   status:    string
 *   files_touched?: string[]
 *
 * Effects:
 *   - Updates agent_workers.last_heartbeat_at and status.
 *   - Inserts a worker_heartbeats row (append-only).
 *   - Emits AgentHeartbeat event via EventStore.
 *
 * bypassScopeCheck: true — this is a system-internal tool; capability validity
 * is checked at connect-time; no specific file/channel scope is required.
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { agentWorkers, workerHeartbeats } from '../../db/schema/worker-tables.js'
import type { MCPTool, ToolContext } from '../registry.js'
import type { EventInput, Actor } from '@orbital/types'
import { logger } from '../../config/logger.js'

const HeartbeatInputSchema = z.object({
  worker_id: z.string().uuid(),
  task_id: z.string().uuid().optional(),
  status: z.string().min(1).max(64),
  files_touched: z.array(z.string()).optional().default([]),
})

const HeartbeatOutputSchema = z.object({
  heartbeat_id: z.string().uuid(),
  received_at: z.string().datetime(),
})

export const workerHeartbeatTool: MCPTool<typeof HeartbeatInputSchema, typeof HeartbeatOutputSchema> =
  {
    name: 'worker.heartbeat',
    description: 'Worker liveness ping. Updates last_heartbeat_at and emits AgentHeartbeat event.',
    inputSchema: HeartbeatInputSchema,
    outputSchema: HeartbeatOutputSchema,
    bypassScopeCheck: true,

    async handler(input, ctx: ToolContext) {
      const { worker_id, task_id, status, files_touched } = input
      const { db, eventStore, bundle, traceId } = ctx

      const now = new Date()
      const heartbeatId = uuidv7()

      // Update agent_workers.last_heartbeat_at + status.
      // Use the worker_id from the request; the bundle.session_id is the worker identity.
      await db
        .update(agentWorkers)
        .set({
          lastHeartbeatAt: now,
          status: mapStatus(status),
        })
        .where(eq(agentWorkers.workerId, worker_id))

      // Append heartbeat row.
      await db.insert(workerHeartbeats).values({
        heartbeatId,
        workerId: worker_id,
        taskId: task_id ?? null,
        ts: now,
        status,
        filesTouched: files_touched ?? [],
      })

      // Emit AgentHeartbeat event.
      const actor: Actor = {
        type: 'persona',
        persona_id: bundle.persona_id,
        session_id: bundle.session_id,
        task_id: bundle.task_id,
      }

      const ev: EventInput = {
        aggregate_id: worker_id,
        aggregate_type: 'orchestration',
        event_type: 'AgentHeartbeat',
        payload: {
          worker_id,
          task_id: task_id ?? null,
          status,
          files_touched: files_touched ?? [],
          heartbeat_id: heartbeatId,
        },
        actor,
        capability_id: bundle.capability_id,
        trace_id: traceId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      }

      await eventStore.append(ev)

      logger.debug({ worker_id, task_id, status, heartbeat_id: heartbeatId }, 'worker.heartbeat')

      return { heartbeat_id: heartbeatId, received_at: now.toISOString() }
    },
  }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map arbitrary status strings to the agent_workers enum.
 * Workers may report granular statuses; we normalize to the schema enum.
 */
function mapStatus(
  status: string,
): 'connecting' | 'active' | 'idle' | 'terminating' | 'terminated' {
  const lower = status.toLowerCase()
  if (lower === 'idle') return 'idle'
  if (lower === 'terminating') return 'terminating'
  if (lower === 'terminated') return 'terminated'
  if (lower === 'connecting') return 'connecting'
  // Default: active (worker is working).
  return 'active'
}
