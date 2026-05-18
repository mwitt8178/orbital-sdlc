/**
 * db/schema/sprint-tick.ts — Drizzle schema for sprint tick infrastructure.
 *
 * [Engineer-Sr · Sonnet · run-sprint-loop]
 *
 * Owned tables:
 *   - sprint_tick_log      — append-only audit of Workflow Status transitions
 *   - project_sprint_policy — per-tenant per-project concurrency/capacity settings
 *   - sprint_tick_leases   — mutex lease table for daemon tick election
 *   - story_pr_runs        — per-story daemon-spawned execution run registry
 *
 * DSQL constraints honoured:
 *   - No foreign keys, triggers, sequences, or materialized views.
 *   - IDs are uuid; app generates UUIDv7.
 *   - clock_timestamp() used for wall-clock timestamps, not CURRENT_TIMESTAMP.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// sprint_tick_log
// ---------------------------------------------------------------------------

/**
 * Append-only log of every Workflow Status transition driven by the
 * daemon sprint-tick worker. Used for the UI activity feed sidebar and
 * audit trail.
 */
export const sprintTickLog = pgTable(
  'sprint_tick_log',
  {
    logId: uuid('log_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    sprintId: uuid('sprint_id').notNull(),
    storyId: uuid('story_id').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    /** Actor that drove the transition: 'daemon:sprint-tick', 'user', etc. */
    actor: text('actor').notNull().default('daemon:sprint-tick'),
    reason: text('reason').notNull(),
    /** Which tick cycle produced this log row. */
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

// ---------------------------------------------------------------------------
// project_sprint_policy
// ---------------------------------------------------------------------------

/**
 * Per-tenant per-project settings controlling sprint-tick dispatch behaviour.
 * One row per project; upserted by the admin UI or defaults on first use.
 */
export const projectSprintPolicy = pgTable(
  'project_sprint_policy',
  {
    policyId: uuid('policy_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    projectId: uuid('project_id').notNull(),
    /** Max simultaneous in_progress stories across all active sprints for this project. */
    maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(3),
    /**
     * Story-point capacity ceiling per sprint. 0 = no additional cap beyond
     * the sprint row's story_point_capacity.
     */
    capacityOverride: integer('capacity_override').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    projectUq: uniqueIndex('project_sprint_policy_project_uq').on(t.tenantId, t.projectId),
  }),
)

export type ProjectSprintPolicyRow = typeof projectSprintPolicy.$inferSelect
export type ProjectSprintPolicyInsert = typeof projectSprintPolicy.$inferInsert

// ---------------------------------------------------------------------------
// sprint_tick_leases
// ---------------------------------------------------------------------------

/**
 * Mutex lease table for daemon tick worker election.
 * One row per tenant; acquired via SELECT ... FOR UPDATE SKIP LOCKED.
 * The daemon inserts a row on boot if absent; updates it on each tick.
 */
export const sprintTickLeases = pgTable('sprint_tick_leases', {
  tenantId: uuid('tenant_id').primaryKey(),
  /** Instance identifier of the daemon currently holding the lease. */
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

// ---------------------------------------------------------------------------
// story_pr_runs
// ---------------------------------------------------------------------------

/**
 * Per-story daemon-spawned execution attempt. One row per attempt; the daemon
 * inserts a row when it picks a story and transitions it to in_progress, and
 * updates it when the run completes or fails.
 *
 * When the story-pr-pipeline Lambda is wired, lambda_invocation_id tracks the
 * async invocation. When it is not yet available, the daemon logs a clear error
 * and sets status='failed' with error_message explaining the missing pipeline.
 */
export const storyPrRuns = pgTable(
  'story_pr_runs',
  {
    runId: uuid('run_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    sprintId: uuid('sprint_id').notNull(),
    storyId: uuid('story_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', {
      enum: ['pending', 'spawning', 'in_progress', 'in_review', 'done', 'failed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    /** Lambda invocation ID when story-pr-pipeline is wired. */
    lambdaInvocationId: text('lambda_invocation_id'),
    /** Reference to worker_runs.run_id from the story-executor package. */
    workerRunId: uuid('worker_run_id'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    bySprint: index('story_pr_runs_sprint_idx').on(t.tenantId, t.sprintId, t.startedAt),
    byStory: index('story_pr_runs_story_idx').on(t.tenantId, t.storyId, t.startedAt),
    byStatus: index('story_pr_runs_status_idx').on(t.status),
  }),
)

export type StoryPrRunRow = typeof storyPrRuns.$inferSelect
export type StoryPrRunInsert = typeof storyPrRuns.$inferInsert
