/**
 * post-pr-opened.ts — On PROpened, create a child code_review task.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * When a PROpened event fires (emitted by GitHubPROrchestrator after a
 * successful PR open), this handler:
 *   1. Loads the author task.
 *   2. Creates a child task with:
 *        persona_id = 'reviewer'
 *        task_type  = 'code_review'
 *        parent_task_id = author_task_id
 *        title = 'Review PR #N'
 *        AC = ['No CHANGES_REQUESTED state on PR #N']
 *   3. Sets tasks.code_review_state = 'awaiting_review' on the author task.
 *   4. Emits CodeReviewStarted.
 *
 * This is a post-event subscriber (not a pre/post hook in the HookEngine sense —
 * it is registered as an EventStore subscriber that triggers async side-effects).
 * It is distinct from the pre/post gate hooks in hooks/engine.ts.
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { tasks } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'
import type { EventEnvelope } from '../events/types.js'
import type { PROpenedPayload } from '../events/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostPROpenedHandlerOptions {
  db: DB
  eventStore: EventStore
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles a PROpened event:
 *   - Creates a child code_review task for the reviewer persona
 *   - Sets code_review_state='awaiting_review' on the author task
 *   - Emits CodeReviewStarted
 *
 * Safe to call multiple times — skips if a reviewer task already exists for
 * this PR (idempotency guard by checking existing tasks with parent_task_id
 * and persona_id='reviewer').
 */
export async function onPROpened(
  envelope: EventEnvelope,
  opts: PostPROpenedHandlerOptions,
): Promise<void> {
  const { db, eventStore } = opts
  const traceId = envelope.trace_id ?? uuidv7()

  const payload = envelope.payload as unknown as PROpenedPayload
  const authorTaskId = payload.task_id
  const prNumber = payload.pr_number

  if (!authorTaskId || !prNumber) {
    logger.warn(
      { envelope },
      'post-pr-opened: PROpened payload missing task_id or pr_number; skipping',
    )
    return
  }

  // 1. Load the author task
  const [authorTask] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.taskId, authorTaskId))
    .limit(1)

  if (!authorTask) {
    logger.warn(
      { authorTaskId, prNumber },
      'post-pr-opened: author task not found; skipping reviewer task creation',
    )
    return
  }

  // 2. Idempotency: check for existing reviewer task for this author task
  const existing = await db
    .select({ taskId: tasks.taskId })
    .from(tasks)
    .where(eq(tasks.parentTaskId, authorTaskId))
    .limit(10)

  const existingReviewerTask = existing.find((t) => {
    // We check via a separate query for persona_id to avoid complex where
    return true // will filter below
  })

  // Actually query with persona filter
  const existingReviewer = await db
    .select({ taskId: tasks.taskId })
    .from(tasks)
    .where(eq(tasks.parentTaskId, authorTaskId))
    .limit(10)

  const reviewerAlreadyCreated = existingReviewer.length > 0
    ? await (async () => {
        const rows = await db
          .select({ taskId: tasks.taskId, personaId: tasks.personaId })
          .from(tasks)
          .where(eq(tasks.parentTaskId, authorTaskId))
          .limit(10)
        return rows.some((r) => r.personaId === 'reviewer')
      })()
    : false

  if (reviewerAlreadyCreated) {
    logger.debug(
      { authorTaskId, prNumber },
      'post-pr-opened: reviewer task already exists for this PR; skipping (idempotent)',
    )
    return
  }

  // 3. Create child code_review task
  const reviewerTaskId = uuidv7()
  const createdByEventId = envelope.event_id ?? uuidv7()

  await db.insert(tasks).values({
    taskId: reviewerTaskId,
    sprintId: authorTask.sprintId,
    ticketId: authorTask.ticketId,
    title: `Review PR #${prNumber}`,
    description: [
      `## Code Review Task`,
      ``,
      `Review PR #${prNumber} opened by task ${authorTaskId.slice(0, 8)}.`,
      ``,
      `**Author task:** ${authorTaskId}`,
      `**PR:** #${prNumber}`,
      ``,
      `## Instructions`,
      ``,
      `1. Read the PR diff: \`gh pr diff ${prNumber}\``,
      `2. Follow the code-review-protocol skill checklist.`,
      `3. Submit a review: APPROVED, CHANGES_REQUESTED, or COMMENTED.`,
    ].join('\n'),
    acceptanceCriteria: [
      `No CHANGES_REQUESTED state on PR #${prNumber}`,
      `Review submitted to GitHub via gh pr review`,
    ],
    storyId: authorTask.storyId,
    personaId: 'reviewer',
    riskClass: authorTask.riskClass,
    state: 'ready',
    retryBudget: 1,
    parentTaskId: authorTaskId,
    wallClockTimeoutMs: 30 * 60 * 1000, // 30 minutes
    tokenBudget: 16000,
    declaredWritePaths: [], // reviewer writes nothing
    createdByEventId,
  })

  logger.info(
    { authorTaskId, reviewerTaskId, prNumber },
    'post-pr-opened: created reviewer child task',
  )

  // 4. Set code_review_state = 'awaiting_review' on author task
  await db
    .update(tasks)
    .set({ codeReviewState: 'awaiting_review' })
    .where(eq(tasks.taskId, authorTaskId))

  // 5. Emit CodeReviewStarted
  await eventStore.append({
    aggregate_id: authorTaskId,
    aggregate_type: 'task',
    event_type: 'CodeReviewStarted',
    payload: {
      author_task_id: authorTaskId,
      reviewer_task_id: reviewerTaskId,
      pr_number: prNumber,
      reviewer_persona_id: 'reviewer',
      started_at: new Date().toISOString(),
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  })

  logger.info(
    { authorTaskId, reviewerTaskId, prNumber },
    'post-pr-opened: CodeReviewStarted emitted; reviewer task ready for scheduling',
  )
}
