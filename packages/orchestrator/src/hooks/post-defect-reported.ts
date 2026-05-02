/**
 * post-defect-reported.ts — Hook that fires after DefectReported is persisted.
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * On DefectReported:
 *   1. Load the author task via task_id in the payload.
 *   2. If iteration_count >= ITERATION_LIMIT (3):
 *      → emit DefectIterationLimitReached
 *      → do NOT re-open / re-spawn
 *   3. Else:
 *      → UPDATE tasks SET state='ready', iteration_count=iteration_count+1,
 *        last_defect_id=<defect_id>,
 *        description = description || '\n\n## Iteration N: defect feedback\n<repro>'
 *      → emit TaskReopenedForDefect
 *
 * The hook is post (fires after the event is persisted; cannot gate it).
 * Timing: the scheduler will pick up the re-opened task on its next tick.
 */

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { defineHook, type HookSpec } from './types.js'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ITERATION_LIMIT = 3

// ---------------------------------------------------------------------------
// Payload schema (matches DefectReportedPayload)
// ---------------------------------------------------------------------------

const DefectReportedPayloadSchema = z.object({
  defect_id: z.string(),
  task_id: z.string(),
  ac_id: z.string(),
  ac_text: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reproduction_steps: z.string(),
  suggested_fix: z.string().nullable().optional(),
  reported_by: z.string(),
  reported_at: z.string(),
})

type DefectReportedPayload = z.infer<typeof DefectReportedPayloadSchema>

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: binds db + eventStore to the post-defect-reported hook.
 * Called at boot time with singleton instances.
 */
export function createPostDefectReportedHook(
  db: DB,
  eventStore: EventStore,
): HookSpec<typeof DefectReportedPayloadSchema> {
  return defineHook({
    slug: 'post-defect-reported',
    description:
      'After an operator reports a defect, re-open the author task for a new iteration, ' +
      'or emit DefectIterationLimitReached if iteration_count >= 3.',
    appliesTo: ['DefectReported'],
    timing: 'post',
    declaredOrder: 200,
    errorCode: 'HOOK_REJECTED_GENERIC',
    payloadSchema: DefectReportedPayloadSchema,

    validator: async (payload: DefectReportedPayload, _ctx) => {
      // Post hooks always return allow:true — they cannot gate a persisted event.
      void onDefectReported(payload, db, eventStore).catch((err: unknown) => {
        logger.error(
          { err, task_id: payload.task_id, defect_id: payload.defect_id },
          'post-defect-reported hook: handler threw (non-gating)',
        )
      })

      return { allow: true }
    },
  })
}

// ---------------------------------------------------------------------------
// Core logic (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Handles the DefectReported event side-effects.
 * Exported so integration tests can call it directly with a controlled DB.
 */
export async function onDefectReported(
  payload: DefectReportedPayload,
  db: DB,
  eventStore: EventStore,
): Promise<void> {
  const { task_id: taskId, defect_id: defectId, reproduction_steps: repro, reported_at: reportedAt } = payload
  const now = new Date()
  const traceId = uuidv7()

  // Load task row
  const [taskRow] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.taskId, taskId))
    .limit(1)

  if (!taskRow) {
    logger.warn({ taskId, defectId }, 'post-defect-reported: task not found; skipping')
    return
  }

  const currentCount = taskRow.iterationCount ?? 0

  if (currentCount >= ITERATION_LIMIT) {
    // Emit limit-reached event — do NOT re-open
    await eventStore.append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'DefectIterationLimitReached',
      payload: {
        task_id: taskId,
        defect_id: defectId,
        iteration_count: currentCount,
        limit: ITERATION_LIMIT,
        reported_at: reportedAt,
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    logger.warn(
      { taskId, defectId, iterationCount: currentCount, limit: ITERATION_LIMIT },
      'post-defect-reported: iteration limit reached; task NOT re-opened (human escalation required)',
    )
    return
  }

  // Increment iteration count and re-open task
  const newIterationCount = currentCount + 1
  const iterationNote =
    `\n\n## Iteration ${newIterationCount}: defect feedback\n\n` +
    `**Defect**: ${defectId}\n` +
    `**AC**: ${payload.ac_text}\n` +
    `**Reproduction steps**: ${repro}` +
    (payload.suggested_fix ? `\n\n**Suggested fix**: ${payload.suggested_fix}` : '')

  const updatedDescription = taskRow.description + iterationNote

  await db
    .update(tasks)
    .set({
      state: 'ready',
      iterationCount: newIterationCount,
      lastDefectId: defectId,
      description: updatedDescription,
      // Reset current worker linkage so the scheduler treats it as a fresh pick
      currentWorkerId: null,
      currentCapabilityId: null,
    })
    .where(eq(tasks.taskId, taskId))

  await eventStore.append({
    aggregate_id: taskId,
    aggregate_type: 'task',
    event_type: 'TaskReopenedForDefect',
    payload: {
      task_id: taskId,
      defect_id: defectId,
      iteration_count: newIterationCount,
      reopened_at: now.toISOString(),
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: traceId,
    occurred_at: now.toISOString(),
    schema_version: 1,
  })

  logger.info(
    { taskId, defectId, iterationCount: newIterationCount },
    'post-defect-reported: task re-opened for defect iteration',
  )
}
