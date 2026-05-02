/**
 * timeout.ts — wall-clock + token-budget enforcement.
 *
 * Per TRD-04 v0.2 §13.
 *
 * Called from Scheduler.tick. For every in-progress task:
 *  - if (now - startedAt) > wallClockTimeoutMs → AgentTimedOut
 *  - if tokensConsumed > tokenBudget → BudgetExceeded
 *
 * The actual SIGTERM/SIGKILL flow is handled by WorkerMonitor; this module
 * emits the events and updates the task row to a terminal state so the next
 * tick treats it as a candidate for retry/escalate.
 */

import { eq } from 'drizzle-orm'
import type { Actor, EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

export interface TimeoutCheckOptions {
  /** Override now() — used by tests. */
  now?: Date
}

export interface TimeoutResult {
  taskId: string
  reason: 'wall_clock' | 'token_budget'
}

/**
 * Iterate in-progress tasks and emit AgentTimedOut / BudgetExceeded for any
 * that exceed their limits. Returns the list of taskIds that were timed out
 * this call.
 */
export async function enforceTimeouts(
  db: DB,
  eventStore: EventStore,
  options: TimeoutCheckOptions = {},
): Promise<TimeoutResult[]> {
  const now = options.now ?? new Date()
  const results: TimeoutResult[] = []

  const inProgress = await db
    .select()
    .from(tasks)
    .where(eq(tasks.state, 'in_progress'))

  for (const t of inProgress) {
    if (!t.startedAt) continue

    const elapsedMs = now.getTime() - new Date(t.startedAt).getTime()

    if (elapsedMs > t.wallClockTimeoutMs) {
      // Mark as failed so retry/escalate can pick it up.
      await db
        .update(tasks)
        .set({ state: 'failed' })
        .where(eq(tasks.taskId, t.taskId))

      const ev: EventInput = {
        aggregate_id: t.currentWorkerId ?? t.taskId,
        aggregate_type: 'orchestration',
        event_type: 'AgentTimedOut',
        payload: {
          worker_id: t.currentWorkerId,
          task_id: t.taskId,
          persona_id: t.personaId,
          reason: 'wall_clock_exceeded',
          wall_clock_timeout_ms: t.wallClockTimeoutMs,
          elapsed_ms: elapsedMs,
        },
        actor: SYSTEM_ACTOR,
        capability_id: t.currentCapabilityId ?? undefined,
        trace_id: t.taskId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      }
      await eventStore.append(ev)

      logger.warn(
        { taskId: t.taskId, elapsedMs, wallClockTimeoutMs: t.wallClockTimeoutMs },
        'enforceTimeouts: wall-clock breach',
      )

      results.push({ taskId: t.taskId, reason: 'wall_clock' })
      continue
    }

    if (t.tokensConsumed > t.tokenBudget) {
      await db
        .update(tasks)
        .set({ state: 'failed' })
        .where(eq(tasks.taskId, t.taskId))

      const ev: EventInput = {
        aggregate_id: t.taskId,
        aggregate_type: 'task',
        event_type: 'BudgetExceeded',
        payload: {
          task_id: t.taskId,
          worker_id: t.currentWorkerId,
          tokens_consumed: t.tokensConsumed,
          token_budget: t.tokenBudget,
          scope: 'task',
        },
        actor: SYSTEM_ACTOR,
        capability_id: t.currentCapabilityId ?? undefined,
        trace_id: t.taskId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      }
      await eventStore.append(ev)

      logger.warn(
        { taskId: t.taskId, tokensConsumed: t.tokensConsumed, tokenBudget: t.tokenBudget },
        'enforceTimeouts: token budget breach',
      )

      results.push({ taskId: t.taskId, reason: 'token_budget' })
    }
  }

  return results
}
