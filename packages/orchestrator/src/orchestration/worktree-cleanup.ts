/**
 * worktree-cleanup.ts — EventStore-driven worktree cleanup on task completion.
 *
 * Per TRD-04 v0.2 §10 (worktree manager) and §7.2:
 * "Worktree Manager.cleanup(worktree_id): kill any process holding it,
 *  git worktree remove --force, mark row released."
 *
 * `WorktreeManager.cleanup(taskId)` is fully implemented but never called.
 * This helper subscribes to the event stream and calls cleanup on every
 * `TaskCompleted` or `TaskFailed` event.
 *
 * Cleanup failure is non-fatal: the error is logged and a `WorktreeCleanupFailed`
 * audit event is emitted via EventStore.append when the event type is supported.
 * If the event type is not in the registry the emit itself would throw; we catch
 * that and fall back to log-only.
 *
 * NOTE TO BOOT AGENT: add the following two lines to src/index.ts after
 * `bootstrapOrchestrationRegistry(…)` and after the WorktreeManager instance
 * is available (currently it is created inline in spawn.ts — you may need to
 * hoist it or pass it in via the registry bootstrap):
 *
 *   import { registerWorktreeCleanup } from './orchestration/worktree-cleanup.js'
 *   const stopWorktreeCleanup = registerWorktreeCleanup({ eventStore, worktreeManager, db })
 *
 * Then add `stopWorktreeCleanup()` to the shutdown handler.
 * `worktreeManager` is a `WorktreeManager` instance (from worktree.ts).
 */

import { uuidv7 } from 'uuidv7'
import type { EventStore } from '../events/store.js'
import type { IWorktreeManager } from './worktree.js'
import type { DB } from '../db/client.js'
import type { EventEnvelope, EventInput } from '../events/types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterWorktreeCleanupOptions {
  eventStore: EventStore
  worktreeManager: IWorktreeManager
  db: DB
}

export interface WorktreeCleanupHandle {
  /** Unsubscribe from the event stream. Safe to call multiple times. */
  stop(): void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR = { type: 'system' as const, component: 'orchestrator' as const }

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Subscribe to the event stream and call `worktreeManager.cleanup(taskId)` on
 * every `TaskCompleted` or `TaskFailed` event.
 *
 * Returns a handle with a `stop()` method that unsubscribes the handler.
 * Non-fatal cleanup failures are logged; a `WorktreeCleanupFailed` audit event
 * is attempted (but suppressed if EventStore rejects the unknown event type).
 */
export function registerWorktreeCleanup(
  opts: RegisterWorktreeCleanupOptions,
): WorktreeCleanupHandle {
  const { eventStore, worktreeManager } = opts

  const stop = eventStore.subscribe(null, (event: EventEnvelope) => {
    if (event.event_type !== 'TaskCompleted' && event.event_type !== 'TaskFailed') return

    const taskId = event.aggregate_id
    if (!taskId) return

    // Fire-and-forget — cleanup is best-effort and non-fatal.
    void (async () => {
      try {
        await worktreeManager.cleanup(taskId)
        logger.info(
          { taskId, event_type: event.event_type, event_id: event.event_id },
          'worktree-cleanup: cleanup completed',
        )
      } catch (err) {
        logger.error(
          { err, taskId, event_type: event.event_type },
          'worktree-cleanup: cleanup failed (non-fatal)',
        )
        // Attempt to emit a WorktreeCleanupFailed audit event.
        // If the event type is not in the EventStore's schema registry the
        // append will throw; we catch that and log only.
        const failureEvent: EventInput = {
          aggregate_id: taskId,
          aggregate_type: 'task',
          event_type: 'WorktreeCleanupFailed',
          payload: {
            task_id: taskId,
            error: err instanceof Error ? err.message : String(err),
            trigger_event_id: event.event_id,
            trigger_event_type: event.event_type,
          },
          actor: SYSTEM_ACTOR,
          trace_id: uuidv7(),
          occurred_at: new Date().toISOString(),
          schema_version: 1,
        }
        try {
          await eventStore.append(failureEvent)
        } catch (emitErr) {
          // WorktreeCleanupFailed may not be in the event catalog yet — log only.
          logger.warn(
            { emitErr, taskId },
            'worktree-cleanup: could not emit WorktreeCleanupFailed event (event type may not be in catalog); logged only',
          )
        }
      }
    })()
  })

  logger.info('worktree-cleanup: subscribed to event stream (TaskCompleted, TaskFailed)')

  return { stop }
}
