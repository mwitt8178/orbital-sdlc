/**
 * Unit tests for RetryPolicy and computeBackoffMs.
 *
 * Pure logic tests + DB-backed test for the recordFailure path. Uses the real
 * Postgres so retry_attempts and escalations rows are written.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { RetryPolicy, computeBackoffMs } from '../../../src/orchestration/retry.js'
import { tasks, retryAttempts, escalations } from '../../../src/db/schema/orchestration.js'
import {
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from '../../../src/orchestration/types.js'

// ---------------------------------------------------------------------------
// computeBackoffMs — pure logic
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  it('attempt 1 returns base (1s)', () => {
    expect(computeBackoffMs(1)).toBe(RETRY_BACKOFF_BASE_MS)
  })

  it('doubles on each attempt up to cap', () => {
    expect(computeBackoffMs(2)).toBe(RETRY_BACKOFF_BASE_MS * 2)
    expect(computeBackoffMs(3)).toBe(RETRY_BACKOFF_BASE_MS * 4)
    expect(computeBackoffMs(4)).toBe(RETRY_BACKOFF_BASE_MS * 8)
  })

  it('caps at RETRY_BACKOFF_MAX_MS', () => {
    expect(computeBackoffMs(20)).toBe(RETRY_BACKOFF_MAX_MS)
  })

  it('attempt < 1 returns base', () => {
    expect(computeBackoffMs(0)).toBe(RETRY_BACKOFF_BASE_MS)
    expect(computeBackoffMs(-3)).toBe(RETRY_BACKOFF_BASE_MS)
  })
})

// ---------------------------------------------------------------------------
// RetryPolicy.recordFailure — DB integration (kept here so all retry tests
// live in one place; real Postgres is required by project rules anyway).
// ---------------------------------------------------------------------------

const eventStore = createEventStore(db, sql)
const policy = new RetryPolicy(db, eventStore)

async function makeTask(retryBudget = 3, attemptCount = 0): Promise<string> {
  const taskId = uuidv7()
  const sprintId = uuidv7()
  // Insert in 'failed' state — the retry policy doesn't care about state itself,
  // only attemptCount + retryBudget. Using 'failed' avoids the in_progress
  // CHECK constraint that requires current_worker_id etc. to be set.
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: `TICKET-${taskId.slice(0, 8)}`,
    title: 'retry test task',
    description: 'unit test fixture',
    acceptanceCriteria: [],
    personaId: 'sr-dev',
    riskClass: 'standard',
    state: 'failed',
    attemptCount,
    retryBudget,
    wallClockTimeoutMs: 60 * 1000,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: [],
    createdByEventId: uuidv7(),
  })
  return taskId
}

beforeEach(async () => {
  // No-op; we generate unique aggregate ids per test.
})

describe('RetryPolicy.recordFailure', () => {
  it('schedules a retry when budget remains and code is retryable', async () => {
    const taskId = await makeTask(3, 0)
    const decision = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })

    expect(decision.kind).toBe('retry')
    if (decision.kind === 'retry') {
      expect(decision.attemptNumber).toBe(1)
      expect(decision.backoffMs).toBe(RETRY_BACKOFF_BASE_MS)
    }

    // retry_attempts row written
    const ras = await db
      .select()
      .from(retryAttempts)
      .where(eq(retryAttempts.taskId, taskId))
    expect(ras.length).toBe(1)

    // task state moved to 'ready'
    const t = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
    expect(t[0]?.state).toBe('ready')
    expect(t[0]?.attemptCount).toBe(1)
  })

  it('escalates when retry budget is exhausted', async () => {
    // attemptCount = retryBudget means next attempt would be retryBudget+1, exhausted.
    const taskId = await makeTask(3, 3)
    const decision = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })

    expect(decision.kind).toBe('escalate')
    if (decision.kind === 'escalate') {
      expect(decision.reason).toBe('retry_budget_exhausted')
    }

    // escalations row written
    const es = await db
      .select()
      .from(escalations)
      .where(eq(escalations.taskId, taskId))
    expect(es.length).toBe(1)

    const t = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
    expect(t[0]?.state).toBe('escalated')
  })

  it('escalates immediately for non-retryable error codes regardless of budget', async () => {
    const taskId = await makeTask(3, 0)
    const decision = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'AUTH_SCOPE_DENIED',
      traceId: uuidv7(),
    })

    expect(decision.kind).toBe('escalate')
    const t = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
    expect(t[0]?.state).toBe('escalated')
  })

  it('exhausts after exactly 3 attempts (default budget)', async () => {
    const taskId = await makeTask(3, 0)

    // attempt 1
    const r1 = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })
    expect(r1.kind).toBe('retry')

    // attempt 2
    const r2 = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })
    expect(r2.kind).toBe('retry')

    // attempt 3
    const r3 = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })
    expect(r3.kind).toBe('retry')

    // attempt 4 → exhausted, escalate
    const r4 = await policy.recordFailure({
      taskId,
      triggeredByEventId: uuidv7(),
      errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
      traceId: uuidv7(),
    })
    expect(r4.kind).toBe('escalate')

    const ras = await db
      .select()
      .from(retryAttempts)
      .where(eq(retryAttempts.taskId, taskId))
    expect(ras.length).toBe(3)
    const es = await db
      .select()
      .from(escalations)
      .where(eq(escalations.taskId, taskId))
    expect(es.length).toBe(1)
  })

  it('throws NOT_FOUND_TASK when task does not exist', async () => {
    await expect(
      policy.recordFailure({
        taskId: uuidv7(),
        triggeredByEventId: uuidv7(),
        errorCode: 'INTERNAL_LLM_PROVIDER_ERROR',
        traceId: uuidv7(),
      }),
    ).rejects.toThrow(/NOT_FOUND_TASK|task .* not found/)
  })
})
