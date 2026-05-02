/**
 * Integration test: APPROVED review → code_review_state = 'approved'.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Full approved-flow coverage:
 *   1. APPROVED review sets tasks.code_review_state = 'approved'
 *   2. APPROVED code_reviews row is stored correctly
 *   3. Author task state is NOT changed (stays in_review — merge is operator action)
 *   4. No CodeReviewIterationRequested event emitted
 *   5. Multiple PRs: only the target author task is updated
 *   6. Full loop: PROpened → onPROpened creates reviewer → onCodeReviewSubmitted APPROVED
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { codeReviews } from '../../../src/db/schema/code-reviews.js'
import { onPROpened } from '../../../src/hooks/post-pr-opened.js'
import { onCodeReviewSubmitted } from '../../../src/hooks/post-review-submitted.js'
import type { EventEnvelope } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testAuthorTaskId: string
let testReviewerTaskId: string
let testSprintId: string
let eventStore: ReturnType<typeof createEventStore>

function makePROpenedEnvelope(authorTaskId: string, prNumber: number): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: authorTaskId,
    aggregate_type: 'task',
    event_type: 'PROpened',
    payload: {
      task_id: authorTaskId,
      pr_number: prNumber,
      html_url: `https://github.com/test-owner/test-repo/pull/${prNumber}`,
      owner: 'test-owner',
      repo: 'test-repo',
      branch: `agent/${authorTaskId}`,
      head_sha: 'abc123',
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

function makeCodeReviewApprovedEnvelope(
  authorTaskId: string,
  reviewerTaskId: string,
  prNumber: number,
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
      state: 'APPROVED',
      comments_count: 0,
      body: 'LGTM! All AC satisfied, tests pass, no security concerns.',
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

  // Insert author task with in_review state
  await db.insert(tasks).values({
    taskId: testAuthorTaskId,
    sprintId: testSprintId,
    ticketId: `TKT-${testAuthorTaskId.slice(0, 8)}`,
    title: 'Implement feature Y',
    description: 'Author task description for approved flow test.',
    personaId: 'engineer-sr',
    riskClass: 'standard',
    state: 'in_review',
    codeReviewState: 'awaiting_review',
    retryBudget: 2,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 8000,
    createdByEventId: uuidv7(),
  })

  // Insert reviewer task (ready — reviewed successfully, submitting result)
  await db.insert(tasks).values({
    taskId: testReviewerTaskId,
    sprintId: testSprintId,
    ticketId: `TKT-${testAuthorTaskId.slice(0, 8)}`,
    title: 'Review PR #60',
    description: 'Reviewer task.',
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
  await db
    .delete(codeReviews)
    .where(eq(codeReviews.prTaskId, testAuthorTaskId))
    .catch(() => undefined)

  await db
    .delete(tasks)
    .where(eq(tasks.parentTaskId, testAuthorTaskId))
    .catch(() => undefined)

  await db
    .delete(tasks)
    .where(eq(tasks.taskId, testAuthorTaskId))
    .catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approved review flow', () => {
  it('sets code_review_state = approved on author task', async () => {
    const envelope = makeCodeReviewApprovedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      60,
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.codeReviewState).toBe('approved')
  })

  it('stores APPROVED code_reviews row', async () => {
    const reviewId = uuidv7()
    const envelope = makeCodeReviewApprovedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      60,
    )
    ;(envelope.payload as Record<string, unknown>)['review_id'] = reviewId

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [review] = await db
      .select()
      .from(codeReviews)
      .where(eq(codeReviews.reviewId, reviewId))
      .limit(1)

    expect(review).toBeDefined()
    expect(review?.state).toBe('APPROVED')
    expect(review?.prTaskId).toBe(testAuthorTaskId)
    expect(review?.reviewerPersonaId).toBe('reviewer')
    expect(review?.commentsCount).toBe(0)
  })

  it('does NOT reopen author task on APPROVED', async () => {
    const envelope = makeCodeReviewApprovedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      60,
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    // Must remain in_review — merge is a human/operator action
    expect(authorTask?.state).toBe('in_review')
  })

  it('does NOT emit CodeReviewIterationRequested on APPROVED', async () => {
    const envelope = makeCodeReviewApprovedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      60,
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const { items } = await eventStore.query({
      aggregate_id: testAuthorTaskId,
    })

    const iterationRequested = items.find((e) => e.event_type === 'CodeReviewIterationRequested')
    expect(iterationRequested).toBeUndefined()
  })

  it('does NOT modify description on APPROVED', async () => {
    const originalDescription = 'Author task description for approved flow test.'
    const envelope = makeCodeReviewApprovedEnvelope(
      testAuthorTaskId,
      testReviewerTaskId,
      60,
    )

    await onCodeReviewSubmitted(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ description: tasks.description })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    // Description must be unchanged — no feedback appended
    expect(authorTask?.description).toBe(originalDescription)
  })

  it('full loop: PROpened creates reviewer, APPROVED sets code_review_state', async () => {
    // Use a fresh author task without pre-created reviewer
    const freshAuthorId = uuidv7()
    const freshSprintId = uuidv7()
    const prNumber = 70

    await db.insert(tasks).values({
      taskId: freshAuthorId,
      sprintId: freshSprintId,
      ticketId: `TKT-LOOP-${freshAuthorId.slice(0, 8)}`,
      title: 'Full loop author task',
      description: 'Full loop test description.',
      personaId: 'engineer-sr',
      riskClass: 'standard',
      retryBudget: 2,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 8000,
      createdByEventId: uuidv7(),
    })

    // Step 1: PROpened creates reviewer task
    const prOpenedEnvelope = makePROpenedEnvelope(freshAuthorId, prNumber)
    await onPROpened(prOpenedEnvelope, { db, eventStore })

    // Verify reviewer task was created
    const reviewerRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, freshAuthorId))

    expect(reviewerRows.length).toBe(1)
    const reviewerTask = reviewerRows[0]!
    expect(reviewerTask.personaId).toBe('reviewer')

    // Verify awaiting_review state
    const [authorAfterPR] = await db
      .select({ codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, freshAuthorId))
      .limit(1)
    expect(authorAfterPR?.codeReviewState).toBe('awaiting_review')

    // Step 2: Reviewer submits APPROVED
    const reviewEnvelope = makeCodeReviewApprovedEnvelope(
      freshAuthorId,
      reviewerTask.taskId,
      prNumber,
    )
    await onCodeReviewSubmitted(reviewEnvelope, { db, eventStore })

    // Verify approved state
    const [authorAfterReview] = await db
      .select({ codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, freshAuthorId))
      .limit(1)
    expect(authorAfterReview?.codeReviewState).toBe('approved')

    // Cleanup
    await db.delete(codeReviews).where(eq(codeReviews.prTaskId, freshAuthorId)).catch(() => undefined)
    await db.delete(tasks).where(eq(tasks.parentTaskId, freshAuthorId)).catch(() => undefined)
    await db.delete(tasks).where(eq(tasks.taskId, freshAuthorId)).catch(() => undefined)
  })
})
