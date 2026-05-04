/**
 * story-pr-runs.ts — Drizzle schema for the Story → PR run aggregate.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 *
 * Migration 0045. The aggregate root for one "click Run on story" execution.
 * State machine: queued → cloning → branching → running_agent → committing →
 * pushing → opening_pr → succeeded | failed | cancelled.
 *
 * Cross-aggregate refs (story_id, project_id) are nullable-uuid logical
 * pointers — no physical FKs (DSQL constraint).
 */

import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const STORY_PR_RUN_STATUS = [
  'queued',
  'cloning',
  'branching',
  'running_agent',
  'committing',
  'pushing',
  'opening_pr',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type StoryPrRunStatus = (typeof STORY_PR_RUN_STATUS)[number]

export interface StoryPrRunDiffStats {
  files?: number
  additions?: number
  deletions?: number
  error?: string
}

export const storyPrRuns = pgTable(
  'story_pr_runs',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id'),
    storyId: uuid('story_id').notNull(),
    branch: text('branch').notNull(),
    prUrl: text('pr_url'),
    status: text('status', { enum: STORY_PR_RUN_STATUS }).notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    commitSha: text('commit_sha'),
    diffStats: jsonb('diff_stats').$type<StoryPrRunDiffStats | null>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byStory: index('story_pr_runs_story_idx').on(t.tenantId, t.storyId, t.startedAt),
    byStatus: index('story_pr_runs_status_idx').on(t.status),
  }),
)

export type StoryPrRunRow = typeof storyPrRuns.$inferSelect
export type StoryPrRunInsert = typeof storyPrRuns.$inferInsert
