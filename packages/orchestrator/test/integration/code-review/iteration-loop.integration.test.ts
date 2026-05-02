/**
 * Integration test: CHANGES_REQUESTED → author task reopens with feedback.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Emits a CodeReviewSubmitted(CHANGES_REQUESTED) → asserts:
 *   1. Author task state = 'ready' (reopened)
 *   2. Author task description contains reviewer feedback section
 *   3. tasks.code_review_state = 'changes_requested' on author task
 *   4. CodeReviewIterationRequested event is appended to event store
 *   5. code_reviews row is upserted with correct state
 *   6. APPROVED path: code_review_state = 'approved', task NOT reopened
 *   7. COMMENTED path: no task state change
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { codeReviews } from '../../../src/db/schema/code-reviews.js'
import { onCodeReviewSubmitted } from '../../../src/hooks/post-review-submitted.js'
import type { EventEnvelope } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testAuthorTaskId: string
let testReviewerTaskId: string
let testSprintId: string
let eventStore: ReturnType<typeof createEventStore>

function makeCodeReviewSubmittedEnvelope(
  authorTaskId: string,
  reviewerTaskId: string,
  prNumber: number,
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
  body = 'Test review feedback',
): EventEnvelope {
  const reviewId = uuidv7()
  return {
    event_id: uuidv7(),
    aggregate_id: authorTaskId,
    aggregate_type: 'task',
    event_type: 'CodeReviewSubmitted',
    payload: {
      review_id: reviewId,
      author_task_id: authorTaskId,
      reviewer_task_id: reviewerTaskId,
      pr_number: prNumber,
      reviewer_persona_id: 'reviewer',
      state,
      comments_count: 2,
      body,
      submitted_at: new Date().toISOString(),
    },
    actor: { type: 'agent', component: 'reviewer' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql`SELECT 1`
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

beforeEach(async () => {
  testAuthorTaskId = uuidv7()
  testReviewerTaskId = uuidv7()
  testSprintId = uuidv7()

  // Insert author task with in_review state (PR has been opened)
  await db.insert(tasks).values({
    taskId: testAuthorTaskId,
    sprintId: testSprintId,
    ticketId: `TKT-${testAuthorTaskId.slice(0, 8)}`,
    title: 'Implement feature X',
    description: 'Author task description. Original work here.',
    personaId: 'engineer-sr',
    riskClass: 'standard',
    state: 'in_review',
    codeReviewState: 'awaiting_review',
    retryBudget: 2,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 8000,
    createdByEventId: uuidv7(),
  })

  // Insert reviewer task (ready — it has been scheduled but we test the submitted path)
  await db.insert(tasks).values({
    taskId: testReviewerTaskId,
    sprintId: testSprintId,
    ticketId: `TKT-${testAuthorTaskId.slice(0, 8)}`,
    title: 'Review PR #50',
    description: 'Reviewer task description.',
    personaId: 'reviewer',
    riskClass: 'standard',
    state: 'ready',
    parentTaskId: testAuthorTaskId,
    retryBudget: 1,
    wallClockTimeoutMs: 30 * 60_000,
    tokenBudget: 16000,
    declaredWritePaths: [],
    createdByEventId: uuidv7(),
  })
})

afterEach(async () => {
  // Clean up code_reviews rows
  await db
    .delete(codeReviews)
    .where(eq(codeReviews.prTaskId, testAuthorTaskId))
    .catch(() => undefined)

  // Clean up reviewer task
  await db
    .delete(tasks)
    .where(eq(tasks.taskId, testReviewerTaskId))
    .catch(() => undefined)

  // Clean up author task
  await db
    .delete(tasks)
    .where(eq(tasks.taskId, testAuthorTaskId))
    .catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('post-review-submitted hook — CHANGES_REQUESTED path', () => {
  it('reopens author task to ready state on CHANGES_REQUESTED', async () => {
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      50,
      'CHANGES_REQUESTED',
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.state).toBe('ready')
  })

  it('appends reviewer feedback to author task description', async () => {
    const feedbackBody = 'Please add test coverage for the error path.'
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      50,
      'CHANGES_REQUESTED',
      feedbackBody,
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ description: tasks.description })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.description).toContain('## Reviewer feedback')
    expect(authorTask?.description).toContain(feedbackBody)
    // Original description is preserved
    expect(authorTask?.description).toContain('Author task description')
  })

  it('sets code_review_state = changes_requested on CHANGES_REQUESTED', async () => {
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      50,
      'CHANGES_REQUESTED',
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.codeReviewState).toBe('changes_requested')
  })

  it('emits CodeReviewIterationRequested event on CHANGES_REQUESTED', async () => {
    const traceId = uuidv7()
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      50,
      'CHANGES_REQUESTED',
    )
    envelope.trace_id = traceId

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const { items } = await eventStore.query({
      aggregate_id: testAuthorTaskId,
    })

    const iterationRequested = items.find((e) => e.event_type === 'CodeReviewIterationRequested')
    expect(iterationRequested).toBeDefined()

    const payload = iterationRequested!.payload as Record<string, unknown>
    expect(payload['author_task_id']).toBe(testAuthorTaskId)
    expect(payload['reviewer_task_id']).toBe(testReviewerTaskId)
    expect(payload['pr_number']).toBe(50)
  })

  it('upserts code_reviews row with CHANGES_REQUESTED state', async () => {
    const reviewPayload = (
      makeCodeReviewSubmittedEnvelope(
        testAuthorTaskId,
        testReviewerTaskId,
        50,
        'CHANGES_REQUESTED',
        'Needs more tests.',
      )
    ).payload as Record<string, unknown>

    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      50,
      'CHANGES_REQUESTED',
      'Needs more tests.',
    )
    // Override so we can look it up by review_id
    const reviewId = uuidv7()
    ;(envelope.payload as Record<string, unknown>)['review_id'] = reviewId

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [review] = await db
      .select()
      .from(codeReviews)
      .where(eq(codeReviews.reviewId, reviewId))
      .limit(1)

    expect(review).toBeDefined()
    expect(review?.state).toBe('CHANGES_REQUESTED')
    expect(review?.prTaskId).toBe(testAuthorTaskId)
    expect(review?.reviewerTaskId).toBe(testReviewerTaskId)
    expect(review?.prNumber).toBe(50)
    expect(review?.body).toBe('Needs more tests.')
  })

  it('is idempotent: second submission with same review_id updates not duplicates', async () => {
    const reviewId = uuidv7()
    const makeEnvelopeWithId = (body: string) => {
      const e = makeCodeReviewSubmittedEnvelope(
        testAuthorTaskId,
        testReviewerTaskId,
        50,
        'CHANGES_REQUESTED',
        body,
      )
      ;(e.payload as Record<string, unknown>)['review_id'] = reviewId
      return e
    }

    // First submission
    await onCodeReviewSubmitted(makeEnvelopeWithId('Original feedback'), { db, eventStore })
    // Second submission (different body)
    await onCodeReviewSubmitted(makeEnvelopeWithId('Updated feedback'), { db, eventStore })

    // Should only have one row for this review_id
    const rows = await db
      .select()
      .from(codeReviews)
      .where(eq(codeReviews.reviewId, reviewId))

    expect(rows.length).toBe(1)
    // Most recent body should be stored
    expect(rows[0]?.body).toBe('Updated feedback')
  })
})

describe('post-review-submitted hook — APPROVED path', () => {
  it('sets code_review_state = approved on APPROVED', async () => {
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      51,
      'APPROVED',
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ codeReviewState: tasks.codeReviewState, state: tasks.state })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.codeReviewState).toBe('approved')
    // Task should NOT have been reopened — stays in in_review (or whatever it was)
    expect(authorTask?.state).toBe('in_review')
  })

  it('does NOT emit CodeReviewIterationRequested on APPROVED', async () => {
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      51,
      'APPROVED',
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const { items } = await eventStore.query({
      aggregate_id: testAuthorTaskId,
    })

    const iterationRequested = items.find((e) => e.event_type === 'CodeReviewIterationRequested')
    expect(iterationRequested).toBeUndefined()
  })
})

describe('post-review-submitted hook — COMMENTED path', () => {
  it('does not change task state on COMMENTED', async () => {
    const envelope = makeCodeReviewSubmittedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      52,
      'COMMENTED',
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ state: tasks.state, codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    // State remains in_review (as set in beforeEach)
    expect(authorTask?.state).toBe('in_review')
    // code_review_state not changed by COMMENTED
    expect(authorTask?.codeReviewState).toBe('awaiting_review')
  })
})

describe('post-review-submitted hook — missing author task', () => {
  it('skips gracefully when author task does not exist', async () => {
    const nonExistentTaskId = uuidv7()
    const envelope = makeCodeReviewSubmittedEnvelope(
      nonExistentTaskId,
      testReviewerTaskId,
      99,
      'CHANGES_REQUESTED',
    )

    // Should not throw
    await expect(
      onCodeReviewSubmitted(envelope, { db, eventStore }),
    ).resolves.toBeUndefined()
  })
})
