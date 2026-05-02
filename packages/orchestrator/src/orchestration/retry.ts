/**
 * retry.ts — RetryPolicy.
 *
 * Per TRD-04 v0.2 §11.
 *
 * On failure:
 *   - If error is non-retryable (per types.NON_RETRYABLE_CODES) → escalate.
 *   - Else if attemptCount + 1 > retryBudget → escalate.
 *   - Else compute exponential backoff (1s, 2s, 4s, ..., cap 60s) and write a
 *     RetryAttempted event + retry_attempts row.
 *
 * On escalation: writes EscalatedToHuman event + escalations row, transitions
 * task state to 'escalated'.
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks, retryAttempts, escalations } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'
import {
  isNonRetryable,
  ORCHESTRATION_ERROR_CODES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  type EscalationReason,
} from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordFailureParams {
  taskId: string
  /**
   * Event id of the TaskFailed | AgentTimedOut | VerifierFailed | HookRejected
   * that triggered this retry decision. Persisted on retry_attempts.
   */
  triggeredByEventId: string
  errorCode: string
  errorDetail?: string
  /** Optional override of escalation reason; default 'retry_budget_exhausted'. */
  forcedEscalationReason?: EscalationReason
  traceId: string
  /** System / human actor that initiated the failure record. */
  actor?: Actor
  /** Override now() for tests. */
  now?: Date
}

export type RetryDecision =
  | {
      kind: 'retry'
      attemptNumber: number
      backoffMs: number
      retryAttemptId: string
    }
  | {
      kind: 'escalate'
      escalationId: string
      reason: EscalationReason
    }

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Public function-style API
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff in ms.
 *
 * attempt=1 → 1s, 2 → 2s, 3 → 4s, ..., capped at 60s.
 * The provided `attempt` is 1-indexed and refers to the NEW attempt number.
 */
export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) return RETRY_BACKOFF_BASE_MS
  const ms = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
  return Math.min(ms, RETRY_BACKOFF_MAX_MS)
}

// ---------------------------------------------------------------------------
// RetryPolicy class — owns DB writes for retry_attempts and escalations
// ---------------------------------------------------------------------------

export interface IRetryPolicy {
  /**
   * Record a task failure and decide retry-vs-escalate.
   * - On retry: writes retry_attempts row, emits RetryAttempted, returns backoffMs.
   * - On escalate: writes escalations row, emits EscalatedToHuman, returns escalationId.
   *
   * Caller is responsible for actually waiting backoffMs and re-spawning. This
   * function is purely the decision + audit step.
   */
  recordFailure(params: RecordFailureParams): Promise<RetryDecision>
}

export class RetryPolicy implements IRetryPolicy {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async recordFailure(params: RecordFailureParams): Promise<RetryDecision> {
    const now = params.now ?? new Date()
    const actor = params.actor ?? SYSTEM_ACTOR

    // Load the task row (we need attemptCount + retryBudget).
    const taskRows = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.taskId, params.taskId))
      .limit(1)
    const task = taskRows[0]
    if (!task) {
      throw new OrbitalError(
        ORCHESTRATION_ERROR_CODES.NOT_FOUND_TASK,
        `task ${params.taskId} not found`,
      )
    }

    const isNonRetry = isNonRetryable(params.errorCode)
    const nextAttempt = task.attemptCount + 1
    const exhausted = nextAttempt > task.retryBudget

    if (isNonRetry || exhausted || params.forcedEscalationReason) {
      const reason: EscalationReason =
        params.forcedEscalationReason ??
        (isNonRetry ? 'retry_budget_exhausted' : 'retry_budget_exhausted')
      return this.escalate({
        taskId: params.taskId,
        reason,
        triggeringEventId: params.triggeredByEventId,
        errorCode: params.errorCode,
        errorDetail: params.errorDetail,
        traceId: params.traceId,
        actor,
        now,
        attemptCount: task.attemptCount,
        retryBudget: task.retryBudget,
      })
    }

    // --- Retry path ---
    const retryAttemptId = uuidv7()
    const backoffMs = computeBackoffMs(nextAttempt)

    await this.db.insert(retryAttempts).values({
      retryAttemptId,
      taskId: params.taskId,
      attemptNumber: nextAttempt,
      triggeredByEventId: params.triggeredByEventId,
      errorCode: params.errorCode,
      routingAdjustment: null,
      decidedAt: now,
    })

    // Bump attemptCount on tasks.
    await this.db
      .update(tasks)
      .set({ attemptCount: nextAttempt, state: 'ready' })
      .where(eq(tasks.taskId, params.taskId))

    const ev: EventInput = {
      aggregate_id: params.taskId,
      aggregate_type: 'task',
      event_type: 'RetryAttempted',
      payload: {
        retry_attempt_id: retryAttemptId,
        task_id: params.taskId,
        attempt_number: nextAttempt,
        triggered_by_event_id: params.triggeredByEventId,
        error_code: params.errorCode,
        error_detail: params.errorDetail,
        backoff_ms: backoffMs,
        retry_budget: task.retryBudget,
      },
      actor,
      trace_id: params.traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    logger.info(
      { taskId: params.taskId, attempt: nextAttempt, backoffMs, errorCode: params.errorCode },
      'RetryPolicy: scheduled retry',
    )

    return { kind: 'retry', attemptNumber: nextAttempt, backoffMs, retryAttemptId }
  }

  // -------------------------------------------------------------------------
  // Internal: escalate
  // -------------------------------------------------------------------------

  private async escalate(params: {
    taskId: string
    reason: EscalationReason
    triggeringEventId: string
    errorCode: string
    errorDetail?: string
    traceId: string
    actor: Actor
    now: Date
    attemptCount: number
    retryBudget: number
  }): Promise<RetryDecision> {
    const escalationId = uuidv7()

    await this.db.insert(escalations).values({
      escalationId,
      taskId: params.taskId,
      reason: params.reason,
      triggeringEventId: params.triggeringEventId,
      context: {
        error_code: params.errorCode,
        error_detail: params.errorDetail,
        attempt_count: params.attemptCount,
        retry_budget: params.retryBudget,
      },
      state: 'open',
      createdAt: params.now,
    })

    await this.db
      .update(tasks)
      .set({ state: 'escalated' })
      .where(eq(tasks.taskId, params.taskId))

    const ev: EventInput = {
      aggregate_id: params.taskId,
      aggregate_type: 'task',
      event_type: 'EscalatedToHuman',
      payload: {
        escalation_id: escalationId,
        task_id: params.taskId,
        reason: params.reason,
        triggering_event_id: params.triggeringEventId,
        error_code: params.errorCode,
        error_detail: params.errorDetail,
        attempt_count: params.attemptCount,
        retry_budget: params.retryBudget,
      },
      actor: params.actor,
      trace_id: params.traceId,
      occurred_at: params.now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    logger.warn(
      {
        taskId: params.taskId,
        escalationId,
        reason: params.reason,
        errorCode: params.errorCode,
      },
      'RetryPolicy: escalating to human',
    )

    return { kind: 'escalate', escalationId, reason: params.reason }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRetryPolicy(db: DB, eventStore: EventStore): RetryPolicy {
  return new RetryPolicy(db, eventStore)
}
