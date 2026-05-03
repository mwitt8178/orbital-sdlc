/**
 * determinism.ts — Drizzle schema for Phase 3B: Hook Engine + Verifiers.
 *
 * Per TRD-09 §4:
 *   - hooks (§4.1)
 *   - hook_versions (§4.2)
 *   - hook_invocations (§4.3)
 *   - verifications (§4.4)
 *   - verification_results (§4.5)
 *   - hook_specifications (§4.6)
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// 4.1 hooks — registry row per hook
// ---------------------------------------------------------------------------

export const hooks = pgTable('hooks', {
  hook_id: uuid('hook_id').primaryKey(),
  hook_slug: text('hook_slug').notNull().unique(),
  description: text('description').notNull(),
  /** FK to hook_versions — points to the active version. */
  current_version_id: uuid('current_version_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type HookRow = typeof hooks.$inferSelect
export type HookInsert = typeof hooks.$inferInsert

// ---------------------------------------------------------------------------
// 4.2 hook_versions — append-only history of hook source revisions
// ---------------------------------------------------------------------------

export const hookVersions = pgTable(
  'hook_versions',
  {
    hook_version_id: uuid('hook_version_id').primaryKey(),
    hook_id: uuid('hook_id').notNull(),
    version: integer('version').notNull(),
    source_sha256: text('source_sha256').notNull(),
    source_text: text('source_text').notNull(),
    applies_to_event_types: jsonb('applies_to_event_types').$type<string[]>().notNull(),
    timing: text('timing', { enum: ['pre', 'post'] }).notNull(),
    declared_order: integer('declared_order').notNull().default(100),
    pr_url: text('pr_url'),
    approved_by_user_id: uuid('approved_by_user_id'),
    approval_event_id: uuid('approval_event_id'),
    shipped_at: timestamp('shipped_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hookVersionUk: uniqueIndex('hook_versions_hook_version_uk').on(t.hook_id, t.version),
  }),
)

export type HookVersionRow = typeof hookVersions.$inferSelect
export type HookVersionInsert = typeof hookVersions.$inferInsert

// ---------------------------------------------------------------------------
// 4.3 hook_invocations — every hook firing (pass or reject)
// ---------------------------------------------------------------------------

export const hookInvocations = pgTable(
  'hook_invocations',
  {
    invocation_id: uuid('invocation_id').primaryKey(),
    hook_id: uuid('hook_id').notNull(),
    hook_version_id: uuid('hook_version_id').notNull(),
    event_type: text('event_type').notNull(),
    timing: text('timing', { enum: ['pre', 'post'] }).notNull(),
    decision: text('decision', { enum: ['allow', 'reject'] }).notNull(),
    reason: text('reason'),
    error_code: text('error_code'),
    duration_ms: integer('duration_ms').notNull(),
    trace_id: text('trace_id').notNull(),
    parent_event_id: uuid('parent_event_id'),
    payload_digest: text('payload_digest').notNull(),
    fired_at: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hookEventIdx: index('hook_inv_hook_event_idx').on(t.hook_id, t.event_type, t.fired_at),
    hookDecisionIdx: index('hook_inv_decision_idx').on(t.decision, t.fired_at),
  }),
)

export type HookInvocationRow = typeof hookInvocations.$inferSelect
export type HookInvocationInsert = typeof hookInvocations.$inferInsert

// ---------------------------------------------------------------------------
// 4.4 verifications — one row per verifier run on a task
// ---------------------------------------------------------------------------

export const verifications = pgTable(
  'verifications',
  {
    verification_id: uuid('verification_id').primaryKey(),
    task_id: uuid('task_id').notNull(),
    ticket_id: text('ticket_id').notNull(),
    verifier_session_id: uuid('verifier_session_id').notNull(),
    status: text('status', { enum: ['running', 'passed', 'failed', 'ambiguous'] }).notNull(),
    ac_count: integer('ac_count').notNull(),
    ac_pass_count: integer('ac_pass_count').notNull().default(0),
    ac_fail_count: integer('ac_fail_count').notNull().default(0),
    ac_ambiguous_count: integer('ac_ambiguous_count').notNull().default(0),
    summary: text('summary'),
    ambiguity_resolution: text('ambiguity_resolution'),
    duration_ms: integer('duration_ms'),
    trace_id: text('trace_id').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    taskIdx: index('verifications_task_idx').on(t.task_id, t.started_at),
  }),
)

export type VerificationRow = typeof verifications.$inferSelect
export type VerificationInsert = typeof verifications.$inferInsert

// ---------------------------------------------------------------------------
// 4.5 verification_results — per-AC verdict rows
// ---------------------------------------------------------------------------

export const verificationResults = pgTable(
  'verification_results',
  {
    result_id: uuid('result_id').primaryKey(),
    verification_id: uuid('verification_id').notNull(),
    ac_index: integer('ac_index').notNull(),
    ac_text: text('ac_text').notNull(),
    verdict: text('verdict', { enum: ['pass', 'fail', 'ambiguous'] }).notNull(),
    reason: text('reason').notNull(),
    evidence_refs: jsonb('evidence_refs').notNull().default('[]'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    verificationIdx: index('vr_verification_idx').on(t.verification_id, t.ac_index),
  }),
)

export type VerificationResultRow = typeof verificationResults.$inferSelect
export type VerificationResultInsert = typeof verificationResults.$inferInsert

// ---------------------------------------------------------------------------
// 4.6 hook_specifications — catalog row per active version
// ---------------------------------------------------------------------------

export const hookSpecifications = pgTable('hook_specifications', {
  spec_id: uuid('spec_id').primaryKey(),
  hook_id: uuid('hook_id').notNull(),
  hook_version_id: uuid('hook_version_id').notNull(),
  name: text('name').notNull(),
  applies_to_event_types: jsonb('applies_to_event_types').$type<string[]>().notNull(),
  timing: text('timing', { enum: ['pre', 'post'] }).notNull(),
  declared_order: integer('declared_order').notNull(),
  declared_error_code: text('declared_error_code').notNull(),
  rationale: text('rationale').notNull(),
  test_fixtures_path: text('test_fixtures_path'),
  loaded_at: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
})

export type HookSpecificationRow = typeof hookSpecifications.$inferSelect
export type HookSpecificationInsert = typeof hookSpecifications.$inferInsert
