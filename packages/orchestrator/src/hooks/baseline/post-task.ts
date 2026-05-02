/**
 * post-task.ts — Baseline post-task hook.
 *
 * Per task spec:
 * - post-task hook: triggers VerifierService.spawnVerifier on task completion.
 * - Applies to TaskCompleted.
 * - Timing: post (fires after the event is persisted; does not gate it).
 * - The validator always returns allow:true; side effect is spawning the verifier.
 * - If spawnVerifier throws, the error is logged but the hook still allows
 *   (post hooks cannot retroactively un-persist the event).
 *
 * Per TRD-09 §10.1: "Working agent emits TaskCompleted with ready_for_verification=true.
 * Orchestrator's reaction handler calls verifierService.spawn(taskId)."
 */

import { z } from 'zod'
import { defineHook, type HookSpec } from '../types.js'
import type { VerifierService } from '../../verifiers/service.js'
import { logger } from '../../config/logger.js'

const PayloadSchema = z.object({
  task_id: z.string(),
  /** Ticket id — needed for verifier spawn. */
  ticket_id: z.string().optional(),
  /** If true, spawn a verifier. */
  ready_for_verification: z.boolean().optional(),
  /** Paths of artifacts produced by the task. */
  artifact_paths: z.array(z.string()).default([]),
  summary: z.string().optional(),
})

type PostTaskPayload = z.infer<typeof PayloadSchema>

/**
 * Factory function that binds the VerifierService to the post-task hook.
 * Called at boot time with the singleton VerifierService instance.
 */
export function createPostTaskHook(
  verifierService: VerifierService,
): HookSpec<typeof PayloadSchema> {
  return defineHook({
    slug: 'post-task-trigger-verifier',
    description:
      'After a task completes with ready_for_verification=true, spawn a verifier worker to check acceptance criteria.',
    appliesTo: ['TaskCompleted'],
    timing: 'post',
    declaredOrder: 100,
    errorCode: 'HOOK_REJECTED_GENERIC',
    payloadSchema: PayloadSchema,
    validator: async (payload: PostTaskPayload, _ctx) => {
      // Post hooks always allow — they cannot gate a persisted event.
      // The side effect is fire-and-forget verifier spawn.
      if (payload.ready_for_verification === true && payload.task_id) {
        const ticketId = payload.ticket_id ?? `task-${payload.task_id}`
        void verifierService
          .spawnVerifier(payload.task_id, ticketId, payload.artifact_paths, 'orchestrator')
          .catch((err: unknown) => {
            logger.error(
              { err, task_id: payload.task_id },
              'post-task hook: spawnVerifier failed (non-gating)',
            )
          })
      }
      return { allow: true }
    },
  })
}
