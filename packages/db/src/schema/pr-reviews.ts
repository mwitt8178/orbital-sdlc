/**
 * pr-reviews.ts — Drizzle schema for the pr_reviews table.
 *
 * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
 *
 * Stores one row per automated PR review run by the Orbital review persona
 * (opus-tier). A verdict of BLOCK prevents the story from transitioning to
 * Done until findings are resolved and a PASS verdict is recorded.
 *
 * Findings JSON shape: Array<{
 *   file: string
 *   line: number | null
 *   severity: 'info' | 'warning' | 'error'
 *   category: 'correctness' | 'security' | 'multi-tenant' | 'observability'
 *   message: string
 * }>
 *
 * DSQL hard-no compliance:
 *   - No foreign keys
 *   - No triggers
 *   - No sequences/SERIAL — UUIDs generated in app (uuidv7)
 *   - DDL in separate migration file
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Finding shape (typed for callers)
// ---------------------------------------------------------------------------

export interface ReviewFinding {
  file: string
  line: number | null
  severity: 'info' | 'warning' | 'error'
  category: 'correctness' | 'security' | 'multi-tenant' | 'observability'
  message: string
}

export const REVIEW_VERDICT = ['PASS', 'BLOCK'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICT)[number]

export const REVIEW_STATUS = ['pending', 'pass', 'block'] as const
export type ReviewStatus = (typeof REVIEW_STATUS)[number]

// ---------------------------------------------------------------------------
// pr_reviews
// ---------------------------------------------------------------------------

export const prReviews = pgTable(
  'pr_reviews',
  {
    /** Primary key: UUID v7 generated in app. */
    id: uuid('id').primaryKey(),

    /**
     * Tenant that owns this review.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     */
    tenantId: uuid('tenant_id').notNull(),

    /** Project the reviewed PR belongs to. Nullable — derived at review time. */
    projectId: uuid('project_id'),

    /** Story the reviewed PR belongs to. Nullable — derived via task lookup. */
    storyId: uuid('story_id'),

    /** Full PR URL (https://github.com/owner/repo/pull/N or CodeCommit equivalent). */
    prUrl: text('pr_url').notNull(),

    /**
     * Review verdict.
     * PASS = story may proceed to Done.
     * BLOCK = story must not be marked Done; reviewer must re-address findings.
     */
    verdict: text('verdict', { enum: REVIEW_VERDICT }).notNull(),

    /**
     * Structured findings list. Empty array = no findings.
     * Shape per ReviewFinding interface above.
     */
    findings: jsonb('findings')
      .$type<ReviewFinding[]>()
      .notNull()
      .default([]),

    /** Persona slug that performed the review. */
    reviewerPersona: text('reviewer_persona').notNull().default('review-agent'),

    /** Claude API cost for this review call in USD. */
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byTenant: index('pr_reviews_tenant_idx').on(t.tenantId),
    byStory: index('pr_reviews_story_idx').on(t.storyId),
    byVerdict: index('pr_reviews_verdict_idx').on(t.verdict),
    byTenantStory: index('pr_reviews_tenant_story_idx').on(t.tenantId, t.storyId),
  }),
)

export type PrReviewRow = typeof prReviews.$inferSelect
export type PrReviewInsert = typeof prReviews.$inferInsert
