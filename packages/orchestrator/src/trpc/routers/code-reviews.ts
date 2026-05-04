/**
 * trpc/routers/code-reviews.ts — Code Review tRPC router.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Procedures:
 *   code_reviews.byPR({ pr_number })         — list reviews for a PR
 *   code_reviews.requestRework({ review_id }) — operator override: reopen author task
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { router, publicProcedure } from '../init.js'
// Round 7-01 — tenant-scoped code-review procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
import { tenantProcedure } from '../middleware/tenant.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import { db as defaultDb } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { db as dbClient, sql } from '../../db/client.js'
import { codeReviews } from '../../db/schema/code-reviews.js'
import { tasks } from '../../db/schema/orchestration.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const byPRInputSchema = z.object({
  pr_number: z.number().int().positive(),
})

const requestReworkInputSchema = z.object({
  review_id: z.string().uuid(),
  operator_feedback: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * @route   code_reviews.byPR
 * @summary List all code reviews for a given PR number.
 * @access  Public
 *
 * @input   {number} pr_number — GitHub PR number
 *
 * @returns Array of code review rows for this PR, ordered by created_at DESC.
 * @returns 404 NOT_FOUND when no reviews exist for this PR number.
 */
export const codeReviewsRouter = router({
  byPR: projectProcedure
    .input(byPRInputSchema)
    .query(async ({ input, ctx }) => {
      // Round 7-02 — hub proxy: code reviews are shared data.
      // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
      const hub = getHubClient()
      if (hub !== null) {
        type ReviewEntry = {
          review_id: string; pr_task_id: string | null; reviewer_task_id: string | null;
          pr_number: number | null; reviewer_persona_id: string; state: string | null;
          comments_count: number; body: string | null; posted_at: string | null;
          created_at: string;
        }
        const result = await hub.query<{ pr_number: number; reviews: ReviewEntry[] }>('code_reviews.byPR', input, ctx.tenantId!)
        if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
        return result.data
      }

      const db = defaultDb
      // fix/multi-project-isolation — scope via parent task projectId
      const rows = await db
        .select({
          reviewId: codeReviews.reviewId,
          prTaskId: codeReviews.prTaskId,
          reviewerTaskId: codeReviews.reviewerTaskId,
          prNumber: codeReviews.prNumber,
          reviewerPersonaId: codeReviews.reviewerPersonaId,
          state: codeReviews.state,
          commentsCount: codeReviews.commentsCount,
          body: codeReviews.body,
          postedAt: codeReviews.postedAt,
          createdAt: codeReviews.createdAt,
        })
        .from(codeReviews)
        .innerJoin(tasks, eq(codeReviews.prTaskId, tasks.taskId))
        .where(
          and(
            eq(codeReviews.prNumber, input.pr_number),
            eq(codeReviews.tenantId, ctx.tenantId!),
            eq(tasks.projectId, ctx.projectId!),
          ),
        )
        .orderBy(codeReviews.createdAt)

      return {
        pr_number: input.pr_number,
        reviews: rows.map((r) => ({
          review_id: r.reviewId,
          pr_task_id: r.prTaskId,
          reviewer_task_id: r.reviewerTaskId,
          pr_number: r.prNumber,
          reviewer_persona_id: r.reviewerPersonaId,
          state: r.state,
          comments_count: r.commentsCount ?? 0,
          body: r.body,
          posted_at: r.postedAt?.toISOString() ?? null,
          created_at: r.createdAt.toISOString(),
        })),
      }
    }),

  /**
   * @route   code_reviews.requestRework
   * @summary Operator override: mark a review as requesting rework
   *          and reopen the author task for another iteration.
   * @access  Public (capability-gated in production)
   *
   * @input   {string} review_id        — UUID of the code review
   * @input   {string} operator_feedback — Optional additional feedback from operator
   *
   * @returns { success: true, author_task_id: string } on success
   * @returns 404 NOT_FOUND when review does not exist
   * @returns 409 CONFLICT when author task is already in 'ready' or 'in_progress' state
   */
  requestRework: projectProcedure
    .input(requestReworkInputSchema)
    .mutation(async ({ input, ctx }) => {
      const db = defaultDb
      const eventStore = createEventStore(dbClient, sql)

      // Load the review scoped to this tenant
      const [reviewRow] = await db
        .select()
        .from(codeReviews)
        .where(and(eq(codeReviews.reviewId, input.review_id), eq(codeReviews.tenantId, ctx.tenantId!)))
        .limit(1)

      if (!reviewRow) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Code review ${input.review_id} not found`,
        })
      }

      // Load the author task scoped to tenant + project
      // fix/multi-project-isolation — verify task is in active project
      const [authorTask] = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.taskId, reviewRow.prTaskId),
            eq(tasks.tenantId, ctx.tenantId!),
            eq(tasks.projectId, ctx.projectId!),
          ),
        )
        .limit(1)

      if (!authorTask) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Author task ${reviewRow.prTaskId} not found`,
        })
      }

      // Conflict guard: can only request rework from terminal / waiting state
      if (authorTask.state === 'in_progress') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Author task ${reviewRow.prTaskId} is already in_progress; cannot request rework now`,
        })
      }

      const feedbackSection = [
        '',
        `## Operator-requested rework (review ${input.review_id})`,
        '',
        input.operator_feedback ?? '(no additional feedback from operator)',
        '',
        `Original review state: ${reviewRow.state}`,
      ].join('\n')

      const updatedDescription = authorTask.description + feedbackSection

      // Reopen author task with feedback (scoped to tenant)
      await db
        .update(tasks)
        .set({
          state: 'ready',
          description: updatedDescription,
          codeReviewState: 'changes_requested',
        })
        .where(
          and(
            eq(tasks.taskId, reviewRow.prTaskId),
            eq(tasks.tenantId, ctx.tenantId!),
            // fix/multi-project-isolation
            eq(tasks.projectId, ctx.projectId!),
          ),
        )

      // Emit CodeReviewIterationRequested
      const traceId = uuidv7()
      await eventStore.append({
        aggregate_id: reviewRow.prTaskId,
        aggregate_type: 'task',
        event_type: 'CodeReviewIterationRequested',
        payload: {
          review_id: input.review_id,
          author_task_id: reviewRow.prTaskId,
          reviewer_task_id: reviewRow.reviewerTaskId,
          pr_number: reviewRow.prNumber,
          feedback_summary: input.operator_feedback ?? `Operator override on review ${input.review_id}`,
          requested_at: new Date().toISOString(),
        },
        actor: { type: 'system', component: 'orchestrator' },
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })

      logger.info(
        { reviewId: input.review_id, authorTaskId: reviewRow.prTaskId },
        'code_reviews.requestRework: author task reopened by operator',
      )

      return {
        success: true,
        author_task_id: reviewRow.prTaskId,
      }
    }),
})

export type CodeReviewsRouter = typeof codeReviewsRouter
