/**
 * registry-bootstrap.ts — Wire orchestration-aware tools into the MCP ToolRegistry.
 *
 * Per TRD-04 v0.2 §6 and §11.
 *
 * Phase 2B registered worker.heartbeat / task.complete / task.fail / task.request_help
 * that emit-only. Phase 2C re-registers task.complete and task.fail with richer
 * handlers that ALSO mutate the tasks table (state machine transitions) and
 * react to a `draining` worker status.
 *
 * The drain mechanism: PauseController marks active workers as status='terminating'.
 * The richer handlers reject any state mutation if the worker is in draining
 * status by returning CONFLICT_INVALID_STATE. Heartbeats continue to work (so
 * monitor still sees the worker alive while it winds down).
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { MCPTool, ToolContext, IToolRegistry } from '../mcp/registry.js'
import type { ICapabilityAuthority } from '../capabilities/authority.js'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import { agentWorkers } from '../db/schema/worker-tables.js'
import { logger } from '../config/logger.js'
import { isValidTaskTransition, ORCHESTRATION_ERROR_CODES } from './types.js'
import type { BoardMappingResolver } from '../backlog/board-mapping-resolver.js'
import { buildMappingResolveTool } from '../mcp/tools/mapping_resolve.js'

// ---------------------------------------------------------------------------
// Schemas — matching the Phase 2B shapes
// ---------------------------------------------------------------------------

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
  state: z.string(),
})

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
  state: z.string(),
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface RegistryBootstrapDeps {
  registry: IToolRegistry
  authority: ICapabilityAuthority
  db: DB
  eventStore: EventStore
}

/**
 * Replace the Phase 2B emit-only handlers with Phase 2C richer handlers.
 * Idempotent — safe to call multiple times.
 */
export function bootstrapOrchestrationRegistry(deps: RegistryBootstrapDeps): void {
  // Deregister the Phase 2B versions (no-op if absent).
  deps.registry.deregister('task.complete')
  deps.registry.deregister('task.fail')

  deps.registry.register(buildTaskCompleteTool(deps))
  deps.registry.register(buildTaskFailTool(deps))

  logger.info('registry-bootstrap: orchestration-aware task.complete + task.fail registered')
}

/**
 * Round 5 addition: register the mapping.resolve tool so persona workers can
 * read the project's confirmed BoardMapping. Idempotent — caller may invoke
 * multiple times (we deregister first).
 *
 * Separate from bootstrapOrchestrationRegistry because the resolver is built
 * after the boards subsystem comes online; calling site is boot.ts after
 * all Round 5 services are wired.
 */
export function registerMappingResolveTool(deps: {
  registry: IToolRegistry
  resolver: BoardMappingResolver
}): void {
  deps.registry.deregister('mapping.resolve')
  deps.registry.register(buildMappingResolveTool(deps.resolver))
  logger.info('registry-bootstrap: mapping.resolve tool registered')
}

// ---------------------------------------------------------------------------
// task.complete — richer handler
// ---------------------------------------------------------------------------

function buildTaskCompleteTool(
  deps: RegistryBootstrapDeps,
): MCPTool<typeof TaskCompleteInputSchema, typeof TaskCompleteOutputSchema> {
  return {
    name: 'task.complete',
    description:
      'Mark the current task as completed. Mutates tasks.state→done and emits TaskCompleted. Honors drain status.',
    inputSchema: TaskCompleteInputSchema,
    outputSchema: TaskCompleteOutputSchema,
    bypassScopeCheck: true,

    async handler(input, ctx: ToolContext) {
      const { task_id, summary, artifacts } = input
      const { bundle, traceId } = ctx
      const completedAt = new Date()

      // Reject if the worker is in draining status (sprint pause mid-flight).
      await assertWorkerNotDraining(deps.db, bundle.session_id)

      // Transactional state transition. Per TRD-04 §7.1, the canonical chain is
      // in_progress → in_review → done. Phase 3B will spawn a verifier between
      // in_review and done. In the absence of verifiers (Phase 2C), the worker's
      // task.complete drives the task all the way to 'done' via the in_review
      // intermediate (atomic in this tx).
      const result = await deps.db.transaction(async (tx) => {
        const taskRows = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.taskId, task_id))
          .limit(1)
        const task = taskRows[0]
        if (!task) {
          throw new OrbitalError(
            ORCHESTRATION_ERROR_CODES.NOT_FOUND_TASK,
            `task ${task_id} not found`,
          )
        }

        // Idempotent: already-done is fine.
        if (task.state === 'done') {
          return { task, state: 'done' as const }
        }

        // From in_progress: go in_progress -> in_review -> done atomically.
        if (task.state === 'in_progress') {
          if (!isValidTaskTransition('in_progress', 'in_review')) {
            throw new OrbitalError(
              ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
              `state machine: in_progress → in_review disallowed`,
            )
          }
          if (!isValidTaskTransition('in_review', 'done')) {
            throw new OrbitalError(
              ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
              `state machine: in_review → done disallowed`,
            )
          }
          await tx
            .update(tasks)
            .set({
              state: 'done',
              completedAt,
            })
            .where(eq(tasks.taskId, task_id))
          return { task, state: 'done' as const }
        }

        // From in_review: directly to done.
        if (task.state === 'in_review') {
          if (!isValidTaskTransition('in_review', 'done')) {
            throw new OrbitalError(
              ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
              `state machine: in_review → done disallowed`,
            )
          }
          await tx
            .update(tasks)
            .set({
              state: 'done',
              completedAt,
            })
            .where(eq(tasks.taskId, task_id))
          return { task, state: 'done' as const }
        }

        throw new OrbitalError(
          ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `Cannot transition task ${task_id} from ${task.state} to done`,
        )
      })

      const actor: Actor = {
        type: 'persona',
        persona_id: bundle.persona_id,
        session_id: bundle.session_id,
        ...(bundle.task_id !== undefined && { task_id: bundle.task_id }),
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
          tokens_consumed: result.task.tokensConsumed,
          duration_ms: result.task.startedAt
            ? completedAt.getTime() - new Date(result.task.startedAt).getTime()
            : 0,
          new_state: result.state,
        },
        actor,
        capability_id: bundle.capability_id,
        trace_id: traceId,
        occurred_at: completedAt.toISOString(),
        schema_version: 1,
      }

      const envelope = await deps.eventStore.append(ev)

      // Best-effort: revoke the worker's capability + mark worker terminated.
      try {
        await deps.authority.revoke(bundle.capability_id, {
          reason: 'task_complete',
          actor,
          trace_id: traceId,
        })
      } catch (err) {
        logger.warn(
          { err, capability_id: bundle.capability_id },
          'task.complete: revoke failed (likely already revoked)',
        )
      }

      await deps.db
        .update(agentWorkers)
        .set({ status: 'terminated' })
        .where(eq(agentWorkers.workerId, bundle.session_id))

      logger.info({ task_id, worker: bundle.session_id }, 'task.complete: task -> done')

      return {
        task_id,
        event_id: envelope.event_id,
        completed_at: completedAt.toISOString(),
        state: result.state,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// task.fail — richer handler
// ---------------------------------------------------------------------------

function buildTaskFailTool(
  deps: RegistryBootstrapDeps,
): MCPTool<typeof TaskFailInputSchema, typeof TaskFailOutputSchema> {
  return {
    name: 'task.fail',
    description:
      'Report task failure. Mutates tasks.state→failed and emits TaskFailed. Phase 2C delegates retry/escalate to RetryPolicy.',
    inputSchema: TaskFailInputSchema,
    outputSchema: TaskFailOutputSchema,
    bypassScopeCheck: true,

    async handler(input, ctx: ToolContext) {
      const { task_id, error_code, error_message, retry_advice } = input
      const { bundle, traceId } = ctx
      const failedAt = new Date()

      await assertWorkerNotDraining(deps.db, bundle.session_id)

      const result = await deps.db.transaction(async (tx) => {
        const taskRows = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.taskId, task_id))
          .limit(1)
        const task = taskRows[0]
        if (!task) {
          throw new OrbitalError(
            ORCHESTRATION_ERROR_CODES.NOT_FOUND_TASK,
            `task ${task_id} not found`,
          )
        }

        const targetState = 'failed' as const
        if (!isValidTaskTransition(task.state, targetState)) {
          if (task.state === 'failed') {
            return { task, state: 'failed' as const }
          }
          throw new OrbitalError(
            ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
            `Cannot transition task ${task_id} from ${task.state} to failed`,
          )
        }

        await tx
          .update(tasks)
          .set({ state: targetState })
          .where(eq(tasks.taskId, task_id))

        return { task, state: targetState }
      })

      const actor: Actor = {
        type: 'persona',
        persona_id: bundle.persona_id,
        session_id: bundle.session_id,
        ...(bundle.task_id !== undefined && { task_id: bundle.task_id }),
      }

      const attemptNumber = result.task.attemptCount + 1

      const ev: EventInput = {
        aggregate_id: task_id,
        aggregate_type: 'task',
        event_type: 'TaskFailed',
        payload: {
          task_id,
          worker_id: bundle.session_id,
          error_code,
          error_detail: error_message,
          attempt_number: attemptNumber,
          retry_eligible: retry_advice !== 'no_retry',
          retry_advice,
          new_state: result.state,
        },
        actor,
        capability_id: bundle.capability_id,
        trace_id: traceId,
        occurred_at: failedAt.toISOString(),
        schema_version: 1,
      }

      const envelope = await deps.eventStore.append(ev)

      // Best-effort: revoke the worker's capability + mark worker terminated.
      try {
        await deps.authority.revoke(bundle.capability_id, {
          reason: 'task_failed',
          reason_detail: error_code,
          actor,
          trace_id: traceId,
        })
      } catch (err) {
        logger.warn(
          { err, capability_id: bundle.capability_id },
          'task.fail: revoke failed',
        )
      }

      await deps.db
        .update(agentWorkers)
        .set({ status: 'terminated' })
        .where(eq(agentWorkers.workerId, bundle.session_id))

      logger.warn(
        { task_id, error_code, worker: bundle.session_id, retry_advice },
        'task.fail: task -> failed',
      )

      // Note: actual retry decision/spawn is the Scheduler's responsibility on
      // the next tick. RetryPolicy may be invoked separately by the daemon.

      return {
        task_id,
        event_id: envelope.event_id,
        failed_at: failedAt.toISOString(),
        state: result.state,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertWorkerNotDraining(db: DB, workerId: string): Promise<void> {
  const rows = await db
    .select()
    .from(agentWorkers)
    .where(eq(agentWorkers.workerId, workerId))
    .limit(1)
  const w = rows[0]
  if (!w) return // no row yet — let the handler proceed (heartbeat will create one)
  // 'terminating' is our drain signal (PauseController sets it).
  if (w.status === 'terminating') {
    throw new OrbitalError(
      ORCHESTRATION_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
      `Worker ${workerId} is draining; mutations rejected`,
      { worker_status: w.status },
    )
  }
}

// Avoid unused-import warning; uuidv7 is exported elsewhere.
export const _registryBootstrapInternals = { uuidv7 }
