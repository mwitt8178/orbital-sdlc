/**
 * trpc/routers/pr-reviews.ts — Automated PR review tRPC router.
 *
 * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
 *
 * Procedures:
 *   prReviews.byStory({ story_id })
 *     — list all review rows for a story, newest first.
 *   prReviews.latest({ story_id })
 *     — the most recent review (or null).
 *   prReviews.canTransitionToDone({ story_id })
 *     — true iff no BLOCK verdict exists on the latest review.
 *       Used by the Done-transition guard.
 *
 * Tenant isolation: every query is scoped by ctx.tenantId via tenantProcedure.
 * No cross-tenant reads are possible.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq } from 'drizzle-orm'

import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db as defaultDb } from '../../db/client.js'
import { prReviews } from '../../db/schema/pr-reviews.js'
import { stories } from '../../db/schema/backlog.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const byStoryInput = z.object({
  story_id: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(10),
})

const latestInput = z.object({
  story_id: z.string().uuid(),
})

const canTransitionInput = z.object({
  story_id: z.string().uuid(),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const prReviewsRouter = router({
  /**
   * @route   prReviews.byStory
   * @summary List all automated review rows for a story, newest-first.
   * @access  Tenant-scoped
   *
   * @input   {string} story_id — UUID of the story
   * @input   {number} limit    — max rows (default 10, max 50)
   *
   * @returns { reviews: PrReviewRow[] }
   */
  byStory: tenantProcedure.input(byStoryInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    const rows = await db
      .select()
      .from(prReviews)
      .where(
        and(
          eq(prReviews.tenantId, ctx.tenantId!),
          eq(prReviews.storyId, input.story_id),
        ),
      )
      .orderBy(desc(prReviews.createdAt))
      .limit(input.limit)

    logger.debug(
      { tenant_id: ctx.tenantId, story_id: input.story_id, count: rows.length },
      'prReviews.byStory: fetched',
    )

    return { reviews: rows }
  }),

  /**
   * @route   prReviews.latest
   * @summary Get the most recent automated review for a story.
   * @access  Tenant-scoped
   *
   * @input   {string} story_id — UUID of the story
   *
   * @returns { review: PrReviewRow | null }
   */
  latest: tenantProcedure.input(latestInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    const rows = await db
      .select()
      .from(prReviews)
      .where(
        and(
          eq(prReviews.tenantId, ctx.tenantId!),
          eq(prReviews.storyId, input.story_id),
        ),
      )
      .orderBy(desc(prReviews.createdAt))
      .limit(1)

    return { review: rows[0] ?? null }
  }),

  /**
   * @route   prReviews.canTransitionToDone
   * @summary Check whether the story is allowed to transition to Done.
   *
   * A story is blocked from Done if:
   *   - A pr_reviews row exists with verdict='BLOCK' for this story, AND
   *   - There is no subsequent PASS row (i.e. the latest verdict is BLOCK).
   *
   * Returns true (allowed) when:
   *   - No reviews exist yet (review not yet run — gate is permissive).
   *   - Latest verdict is PASS.
   *   - stories.review_status is 'pass' or null.
   *
   * @access  Tenant-scoped
   *
   * @input   {string} story_id — UUID of the story
   *
   * @returns { allowed: boolean; reason: string; latest_verdict: 'PASS'|'BLOCK'|null }
   */
  canTransitionToDone: tenantProcedure.input(canTransitionInput).query(async ({ ctx, input }) => {
    const db = defaultDb

    // Check stories.review_status first (fast path — single row read)
    const storyRows = await db
      .select({ reviewStatus: stories.reviewStatus })
      .from(stories)
      .where(
        and(
          eq(stories.storyId, input.story_id),
          eq(stories.tenantId, ctx.tenantId!),
        ),
      )
      .limit(1)

    const reviewStatus = storyRows[0]?.reviewStatus ?? null

    if (reviewStatus === 'block') {
      return {
        allowed: false,
        reason: 'Latest automated review verdict is BLOCK. Resolve findings before marking Done.',
        latest_verdict: 'BLOCK' as const,
      }
    }

    if (reviewStatus === 'pass') {
      return {
        allowed: true,
        reason: 'Latest automated review verdict is PASS.',
        latest_verdict: 'PASS' as const,
      }
    }

    // Null / pending: check the actual pr_reviews rows for belt-and-suspenders
    const latestRows = await db
      .select({ verdict: prReviews.verdict })
      .from(prReviews)
      .where(
        and(
          eq(prReviews.tenantId, ctx.tenantId!),
          eq(prReviews.storyId, input.story_id),
        ),
      )
      .orderBy(desc(prReviews.createdAt))
      .limit(1)

    const latest = latestRows[0]?.verdict ?? null

    if (latest === 'BLOCK') {
      return {
        allowed: false,
        reason: 'Latest automated review verdict is BLOCK. Resolve findings before marking Done.',
        latest_verdict: 'BLOCK' as const,
      }
    }

    return {
      allowed: true,
      reason: latest === 'PASS' ? 'Latest automated review verdict is PASS.' : 'No automated review run yet.',
      latest_verdict: (latest ?? null) as 'PASS' | 'BLOCK' | null,
    }
  }),
})

export type PrReviewsRouter = typeof prReviewsRouter
