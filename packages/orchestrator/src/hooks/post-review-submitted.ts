/**
 * post-review-submitted.ts — Handle CodeReviewSubmitted events.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * When CodeReviewSubmitted fires:
 *
 * If state=CHANGES_REQUESTED:
 *   1. Append reviewer feedback to author task description.
 *   2. Reopen author task (state → 'ready').
 *   3. Emit CodeReviewIterationRequested.
 *   4. Set tasks.code_review_state = 'changes_requested'.
 *
 * If state=APPROVED:
 *   1. Set tasks.code_review_state = 'approved' on author task.
 *   2. (UI picks this up and shows "Ready to merge".)
 *
 * If state=COMMENTED:
 *   1. No task state change. Review is informational.
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import { codeReviews } from '../db/schema/code-reviews.js'
import { logger } from '../config/logger.js'
import type { EventEnvelope } from '../events/types.js'
import type { CodeReviewSubmittedPayload } from '../events/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostReviewSubmittedHandlerOptions {
  db: DB
  eventStore: EventStore
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function onCodeReviewSubmitted(
  envelope: EventEnvelope,
  opts: PostReviewSubmittedHandlerOptions,
): Promise<void> {
  const { db, eventStore } = opts
  const traceId = envelope.trace_id ?? uuidv7()

  const payload = envelope.payload as unknown as CodeReviewSubmittedPayload
  const {
    review_id,
    author_task_id,
    reviewer_task_id,
    pr_number,
    reviewer_persona_id,
    state,
    comments_count,
    body,
  } = payload

  if (!review_id || !author_task_id) {
    logger.warn(
      { payload },
      'post-review-submitted: missing review_id or author_task_id; skipping',
    )
    return
  }

  // 1. Insert/update code_reviews row
  await db.insert(codeReviews).values({
    reviewId: review_id,
    prTaskId: author_task_id,
    reviewerTaskId: reviewer_task_id,
    prNumber: pr_number,
    reviewerPersonaId: reviewer_persona_id ?? 'reviewer',
    state,
    commentsCount: comments_count ?? 0,
    body: body ?? null,
    postedAt: new Date(),
    submittedByEventId: envelope.event_id ?? null,
  }).onConflictDoUpdate({
    target: codeReviews.reviewId,
    set: {
      state,
      commentsCount: comments_count ?? 0,
      body: body ?? null,
      postedAt: new Date(),
      updatedAt: new Date(),
    },
  })

  logger.info(
    { review_id, author_task_id, state, pr_number },
    'post-review-submitted: code_reviews row upserted',
  )

  if (state === 'APPROVED') {
    // Set code_review_state = 'approved' on author task
    await db
      .update(tasks)
      .set({ codeReviewState: 'approved' })
      .where(eq(tasks.taskId, author_task_id))

    logger.info(
      { author_task_id, review_id },
      'post-review-submitted: APPROVED — tasks.code_review_state set to "approved"',
    )
    return
  }

  if (state === 'COMMENTED') {
    // Informational only — no task state change
    logger.info(
      { author_task_id, review_id },
      'post-review-submitted: COMMENTED — no task state change',
    )
    return
  }

  // state === 'CHANGES_REQUESTED'
  // 2. Load author task
  const [authorTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.taskId, author_task_id))
    .limit(1)

  if (!authorTask) {
    logger.warn(
      { author_task_id, review_id },
      'post-review-submitted: author task not found; skipping reopen',
    )
    return
  }

  // 3. Append feedback to author task description
  const feedbackSection = [
    '',
    `## Reviewer feedback (PR #${pr_number})`,
    '',
    body ?? '(no review body provided)',
    '',
    `*Review ID: ${review_id} · Reviewer task: ${reviewer_task_id}*`,
  ].join('\n')

  const updatedDescription = authorTask.description + feedbackSection

  // 4. Reopen author task (state → 'ready') with appended feedback
  await db
    .update(tasks)
    .set({
      state: 'ready',
      description: updatedDescription,
      codeReviewState: 'changes_requested',
    })
    .where(eq(tasks.taskId, author_task_id))

  logger.info(
    { author_task_id, review_id, pr_number },
    'post-review-submitted: CHANGES_REQUESTED — author task reopened with feedback',
  )

  // 5. Emit CodeReviewIterationRequested
  await eventStore.append({
    aggregate_id: author_task_id,
    aggregate_type: 'task',
    event_type: 'CodeReviewIterationRequested',
    payload: {
      review_id,
      author_task_id,
      reviewer_task_id,
      pr_number,
      feedback_summary: body ?? '',
      requested_at: new Date().toISOString(),
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  })

  logger.info(
    { author_task_id, review_id },
    'post-review-submitted: CodeReviewIterationRequested emitted',
  )
}
