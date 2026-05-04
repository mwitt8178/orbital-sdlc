/**
 * orchestration.ts — Drizzle schema for Phase 2C orchestration tables.
 *
 * Per TRD-04 v0.2 §4.
 *
 * Owned tables (this file):
 *   - tasks
 *   - task_dependencies
 *   - retry_attempts
 *   - escalations
 *   - worktrees
 *   - worker_pool_state
 *
 * NOT owned here (declared in worker-tables.ts at Phase 2B):
 *   - agent_workers
 *   - worker_heartbeats
 *
 * Cross-file references to agent_workers / worker_heartbeats are via the
 * exports in ./worker-tables.js — never redeclared here.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  bigint,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.1. The full lifecycle row for a single ticket-bound unit
 * of agent work.
 *
 * Invariants enforced via SQL CHECK constraints in 0006_orchestration.sql:
 *   - state='in_progress' ⇔ all current* fields NOT NULL
 *   - state IN ('pending','ready') ⇒ currentWorkerId IS NULL
 *   - attempt_count <= retry_budget + 1
 */
export const tasks = pgTable(
  'tasks',
  {
    taskId: uuid('task_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    /** fix/multi-project-isolation — multi-project scoping (mirrors migration 0015). */
    projectId: uuid('project_id'),
    sprintId: uuid('sprint_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    /** AC strings; can be empty array. */
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull().default([]),

    // Backlog linkage (TRD-04 §4.1 reconciliation note; populated by TRD-02).
    storyId: uuid('story_id'),
    mondaySubitemId: text('monday_subitem_id'),
    ordering: integer('ordering'),
    estimatedDurationMs: integer('estimated_duration_ms'),
    /** Initial value supplied by decomposition; append-only at runtime. */
    linkedArtifacts: jsonb('linked_artifacts')
      .$type<Array<{ type: string; id: string }>>()
      .notNull()
      .default([]),

    // Routing inputs
    personaId: text('persona_id').notNull(),
    riskClass: text('risk_class', {
      enum: ['low', 'standard', 'high', 'critical'],
    })
      .notNull()
      .default('standard'),

    // Lifecycle
    state: text('state', {
      enum: [
        'pending',
        'ready',
        'in_progress',
        'in_review',
        'blocked',
        'failed',
        'escalated',
        'done',
      ],
    })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    retryBudget: integer('retry_budget').notNull(),
    parentTaskId: uuid('parent_task_id'),

    // Execution-time linkage (all NULL except in 'in_progress' state).
    currentWorkerId: uuid('current_worker_id'),
    currentCapabilityId: uuid('current_capability_id'),
    currentRoutingDecisionId: uuid('current_routing_decision_id'),
    currentWorktreeId: uuid('current_worktree_id'),

    // Budgets / timeouts
    wallClockTimeoutMs: integer('wall_clock_timeout_ms').notNull(),
    tokenBudget: integer('token_budget').notNull(),
    tokensConsumed: integer('tokens_consumed').notNull().default(0),

    /**
     * Flat set of write-path globs declared by the task's persona at task-create
     * time. Used by the cross-sprint conflict gate in Scheduler.feasible().
     * Authoritative copy lives on the capability bundle; this is a denormalized
     * cache for fast scheduling. Drift is detected by the audit reconciler.
     */
    declaredWritePaths: jsonb('declared_write_paths')
      .$type<string[]>()
      .notNull()
      .default([]),

    // Round 6 #3 — Defect iteration tracking
    // [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
    /** How many defect-driven re-spawns have been requested for this task. */
    iterationCount: integer('iteration_count').notNull().default(0),
    /** ID of the most recent defect that triggered a re-spawn. */
    lastDefectId: uuid('last_defect_id'),

    // GitHub PR linkage (Round 5D — additive; all nullable)
    githubPrNumber: integer('github_pr_number'),
    githubPrUrl: text('github_pr_url'),
    githubPrMergedAt: timestamp('github_pr_merged_at', { withTimezone: true, mode: 'date' }),
    // Round 6 #1 — head SHA needed for CI re-run on same commit + PR state
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    githubHeadSha: text('github_head_sha'),
    githubPrState: text('github_pr_state', { enum: ['open', 'merged', 'closed'] }),

    // Round 6 #2 — code review state (denormalized from code_reviews for fast backlog filter)
    // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
    codeReviewState: text('code_review_state', {
      enum: ['awaiting_review', 'changes_requested', 'approved'],
    }),

    // Round 6 #9 — Inter-Agent Channel Collaboration: telemetry counter for escalations
    // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
    escalationCount: integer('escalation_count').notNull().default(0),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** EventId of the TaskCreated row that produced this task. */
    createdByEventId: uuid('created_by_event_id').notNull(),
  },
  (t) => ({
    bySprint: index('tasks_sprint_idx').on(t.sprintId, t.state),
    byTicket: index('tasks_ticket_idx').on(t.ticketId),
    byState: index('tasks_state_idx').on(t.state),
    byStory: index('tasks_story_idx').on(t.storyId),
    byProject: index('tasks_project_idx').on(t.projectId),
  }),
)

export type TaskRow = typeof tasks.$inferSelect
export type TaskInsert = typeof tasks.$inferInsert

// ---------------------------------------------------------------------------
// task_dependencies
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.2. DAG edges. A `successor` cannot transition
 * pending → ready until every predecessor reaches `done` (when blocking=true).
 */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    predecessorTaskId: uuid('predecessor_task_id').notNull(),
    successorTaskId: uuid('successor_task_id').notNull(),
    dependencyType: text('dependency_type', {
      enum: ['explicit', 'file_based', 'implicit'],
    }).notNull(),
    /** Hard prerequisite (true) vs informational/advisory (false). */
    blocking: boolean('blocking').notNull().default(true),
    /** For file_based edges, the overlapping glob pattern. */
    filePathPattern: text('file_path_pattern'),
    /** For explicit edges, the originating ticket link (e.g. Monday "blocked by"). */
    derivedFromTicketLink: text('derived_from_ticket_link'),
    rationale: text('rationale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.predecessorTaskId, t.successorTaskId] }),
    bySuccessor: index('task_deps_successor_idx').on(t.successorTaskId),
  }),
)

export type TaskDependencyRow = typeof taskDependencies.$inferSelect
export type TaskDependencyInsert = typeof taskDependencies.$inferInsert

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.3. One worktree per active task; reused across retries
 * to preserve work-in-progress, deleted on `done` or `escalated`.
 */
export const worktrees = pgTable(
  'worktrees',
  {
    worktreeId: uuid('worktree_id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    /** Filesystem path: ~/.orbital/worktrees/{task_id}. */
    path: text('path').notNull(),
    branchName: text('branch_name').notNull(),
    parentBranch: text('parent_branch').notNull(),
    state: text('state', {
      enum: ['creating', 'active', 'draining', 'cleaning', 'released'],
    }).notNull(),
    /** files_write scope from the issued capability. */
    declaredWritePaths: jsonb('declared_write_paths')
      .$type<string[]>()
      .notNull()
      .default([]),
    conflictsWithWorktreeId: uuid('conflicts_with_worktree_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    /** Only one active (un-released) worktree per task. */
    activeUq: uniqueIndex('worktrees_task_uq')
      .on(t.taskId)
      .where(sql`released_at IS NULL`),
    byTask: index('worktrees_task_idx').on(t.taskId),
  }),
)

export type WorktreeRow = typeof worktrees.$inferSelect
export type WorktreeInsert = typeof worktrees.$inferInsert

// ---------------------------------------------------------------------------
// retry_attempts
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.5. One row per retry decision.
 * attempt_number is 1-indexed; the original attempt is row 1 (created when
 * the first AgentSpawned fires); retries are rows 2..N.
 */
export const retryAttempts = pgTable(
  'retry_attempts',
  {
    retryAttemptId: uuid('retry_attempt_id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    /** EventId of the TaskFailed | AgentTimedOut | VerifierFailed | HookRejected. */
    triggeredByEventId: uuid('triggered_by_event_id').notNull(),
    errorCode: text('error_code').notNull(),
    /** Free-form routing tweak (e.g. {"escalateModel": true}). */
    routingAdjustment: jsonb('routing_adjustment').$type<Record<string, unknown>>(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byTask: index('retry_task_idx').on(t.taskId, t.attemptNumber),
  }),
)

export type RetryAttemptRow = typeof retryAttempts.$inferSelect
export type RetryAttemptInsert = typeof retryAttempts.$inferInsert

// ---------------------------------------------------------------------------
// escalations
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.5. One row per escalation event.
 */
export const escalations = pgTable(
  'escalations',
  {
    escalationId: uuid('escalation_id').primaryKey(),
    taskId: uuid('task_id').notNull(),
    reason: text('reason', {
      enum: [
        'retry_budget_exhausted',
        'timeout_after_retries',
        'blocker_unresolvable',
        'disagreement_unresolvable',
        'hook_rejected_critical',
        'manual_admin_kill',
      ],
    }).notNull(),
    triggeringEventId: uuid('triggering_event_id').notNull(),
    /** Surfaces to UI; e.g. attempt history, last error, worktree path. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    state: text('state', {
      enum: ['open', 'acknowledged', 'resolved', 'cancelled'],
    })
      .notNull()
      .default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byTask: index('escalations_task_idx').on(t.taskId),
    byState: index('escalations_state_idx').on(t.state),
  }),
)

export type EscalationRow = typeof escalations.$inferSelect
export type EscalationInsert = typeof escalations.$inferInsert

// ---------------------------------------------------------------------------
// worker_pool_state
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 v0.2 §4.4 (last block). Single-row table. Functions as a global
 * mutex/state for the pool. id = 1 is enforced by CHECK constraint.
 */
export const workerPoolState = pgTable('worker_pool_state', {
  id: integer('id').primaryKey().default(1),
  maxConcurrentWorkers: integer('max_concurrent_workers').notNull().default(8),
  maxActiveSprints: integer('max_active_sprints').notNull().default(3),
  paused: boolean('paused').notNull().default(false),
  pausedReason: text('paused_reason'),
  pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }),
  /** Monotonic; bumped on each pause/resume edge. */
  schedulerEpoch: bigint('scheduler_epoch', { mode: 'number' })
    .notNull()
    .default(0),
})

export type WorkerPoolStateRow = typeof workerPoolState.$inferSelect

// ---------------------------------------------------------------------------
// Re-exports of cross-file references (for callers who import only this file)
// ---------------------------------------------------------------------------

export { agentWorkers, workerHeartbeats } from './worker-tables.js'
export type { AgentWorkerRow, WorkerHeartbeatRow } from './worker-tables.js'
