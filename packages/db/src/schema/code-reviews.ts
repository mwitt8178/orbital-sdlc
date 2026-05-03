/**
 * code-reviews.ts — Drizzle schema for the code_reviews table.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Stores one row per code review submitted by the reviewer persona.
 * A single PR may have multiple review iterations (one per CHANGES_REQUESTED
 * → author iterates → re-review cycle).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// code_reviews
// ---------------------------------------------------------------------------

export const codeReviews = pgTable(
  'code_reviews',
  {
    /** Primary key: UUID v7 generated in app. */
    reviewId: uuid('review_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),

    /**
     * The task that owns the PR being reviewed.
     * This is the AUTHOR task_id, not the reviewer task_id.
     * Logical FK into tasks(task_id).
     */
    prTaskId: uuid('pr_task_id').notNull(),

    /**
     * The reviewer child task that performed this review.
     * Logical FK into tasks(task_id).
     */
    reviewerTaskId: uuid('reviewer_task_id').notNull(),

    /** GitHub PR number. */
    prNumber: integer('pr_number').notNull(),

    /** Persona slug of the reviewer (e.g. "reviewer"). */
    reviewerPersonaId: text('reviewer_persona_id').notNull(),

    /**
     * Review state emitted by the reviewer.
     * APPROVED = author may proceed to merge.
     * CHANGES_REQUESTED = author must iterate.
     * COMMENTED = informational only (no block, no approval).
     */
    state: text('state', {
      enum: ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'],
    }).notNull(),

    /** Number of inline file comments posted to the PR. */
    commentsCount: integer('comments_count').notNull().default(0),

    /** Review body summary text. */
    body: text('body'),

    /** ISO timestamp when the review was posted to GitHub. */
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),

    /** EventId of CodeReviewSubmitted that created this row. */
    submittedByEventId: uuid('submitted_by_event_id'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byPrTask: index('code_reviews_pr_task_idx').on(t.prTaskId),
    byPrNumber: index('code_reviews_pr_number_idx').on(t.prNumber),
    byState: index('code_reviews_state_idx').on(t.state),
    byReviewerTask: index('code_reviews_reviewer_task_idx').on(t.reviewerTaskId),
  }),
)

export type CodeReviewRow = typeof codeReviews.$inferSelect
export type CodeReviewInsert = typeof codeReviews.$inferInsert
