/**
 * db/schema/sprint-tick.ts — Drizzle schema for sprint tick infrastructure.
 *
 * Owned tables:
 *   - sprint_tick_log      — append-only audit of Workflow Status transitions
 *   - sprint_tick_leases   — mutex lease table for daemon tick election
 *
 * Note: project_sprint_policy lives in ./project-sprint-policy.ts (settings-sprints branch).
 *       story_pr_runs lives in ./story-pr-runs.ts (story-pr-pipeline branch).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

export const sprintTickLog = pgTable(
  'sprint_tick_log',
  {
    logId: uuid('log_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    sprintId: uuid('sprint_id').notNull(),
    storyId: uuid('story_id').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull().default('daemon:sprint-tick'),
    reason: text('reason').notNull(),
    tickId: uuid('tick_id').notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    bySprint: index('sprint_tick_log_sprint_idx').on(t.tenantId, t.sprintId, t.loggedAt),
    byStory: index('sprint_tick_log_story_idx').on(t.tenantId, t.storyId, t.loggedAt),
    byTick: index('sprint_tick_log_tick_idx').on(t.tickId),
  }),
)

export type SprintTickLogRow = typeof sprintTickLog.$inferSelect
export type SprintTickLogInsert = typeof sprintTickLog.$inferInsert

export const sprintTickLeases = pgTable('sprint_tick_leases', {
  tenantId: uuid('tenant_id').primaryKey(),
  holderId: text('holder_id').notNull().default(''),
  acquiredAt: timestamp('acquired_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

export type SprintTickLeaseRow = typeof sprintTickLeases.$inferSelect
export type SprintTickLeaseInsert = typeof sprintTickLeases.$inferInsert
