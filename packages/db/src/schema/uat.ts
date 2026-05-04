/**
 * uat.ts — Drizzle schema for Phase 5A UAT workflow tables.
 *
 * Per TRD-11 v0.2 §4.
 *
 * Owned tables (this file):
 *   - uat_sessions
 *   - uat_ac_results
 *   - defects
 *   - defect_lineage
 *   - persona_of_record_links
 *
 * Cross-context references (NOT redefined here):
 *   - story_acceptance_criteria.ac_id → owned by TRD-02 (db/schema/backlog.ts)
 *   - tasks.task_id, tasks.persona_id → owned by TRD-04 (db/schema/orchestration.ts)
 *   - capability_grants → owned by TRD-06 (db/schema/capabilities.ts)
 *
 * Within-context FKs: uat_ac_results → uat_sessions; defects → uat_sessions + uat_ac_results;
 * defect_lineage → defects (unique). Cross-context references are nullable uuid columns
 * without physical FKs (consistent with TRD-04 §4.1 reconciliation note pattern).
 *
 * Note on fixing_ticket_id (TRD-11 §4.3 cross-TRD contract):
 *   This column is defined here but populated by TRD-02's defect-promotion handler
 *   when a defect fix story is created. Value = TRD-02 stories.story_id. NULL until promoted.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

export const UAT_SESSION_STATE = [
  'started',
  'in_progress',
  'submitted',
  'accepted',
  'partially_accepted',
  'rejected',
] as const
export type UATSessionState = (typeof UAT_SESSION_STATE)[number]

export const UAT_AC_STATUS = ['pending', 'pass', 'fail'] as const
export type UATACStatus = (typeof UAT_AC_STATUS)[number]

export const DEFECT_SEVERITY = ['critical', 'high', 'medium', 'low'] as const
export type DefectSeverity = (typeof DEFECT_SEVERITY)[number]

export const DEFECT_STATE = [
  'open',
  'triaged',
  'assigned',
  'in_progress',
  'resolved',
  'verified',
  'reopened',
  'closed',
] as const
export type DefectState = (typeof DEFECT_STATE)[number]

export const POR_ROLE = [
  'implementation',
  'verification',
  'review',
  'tests',
  'design',
  'architecture',
] as const
export type PORRole = (typeof POR_ROLE)[number]

// ---------------------------------------------------------------------------
// uat_sessions
// ---------------------------------------------------------------------------

/**
 * Per TRD-11 v0.2 §4.1.
 *
 * One session = one human pass over a feature's AC list.
 * A story can have multiple sessions (one per re-UAT after defect fix).
 * UNIQUE (ticket_id, session_version) enforced via constraint.
 *
 * assumptions_snapshot: materialised at session start per §4.6; stores
 * the union of vision-source and worker-source assumptions frozen at start.
 */
export const uatSessions = pgTable(
  'uat_sessions',
  {
    uatSessionId: uuid('uat_session_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    /** fix/multi-project-isolation — multi-project scoping (mirrors migration 0015). */
    projectId: uuid('project_id'),
    ticketId: uuid('ticket_id').notNull(),
    storyVersion: integer('story_version').notNull(),
    sessionVersion: integer('session_version').notNull(),
    state: text('state', { enum: UAT_SESSION_STATE }).notNull().default('started'),
    triggeredByEventId: uuid('triggered_by_event_id').notNull(),
    buildRef: text('build_ref').notNull(),
    startedByUserId: text('started_by_user_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    totalAcCount: integer('total_ac_count').notNull(),
    passCount: integer('pass_count').notNull().default(0),
    failCount: integer('fail_count').notNull().default(0),
    outcomeNotes: text('outcome_notes'),
    assumptionsSnapshot: jsonb('assumptions_snapshot')
      .$type<AssumptionItem[]>()
      .notNull()
      .default([]),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    byTicket: index('uat_sessions_ticket_idx').on(t.ticketId, t.sessionVersion),
    uniqPerVersion: unique('uat_sessions_ticket_version_uniq').on(t.ticketId, t.sessionVersion),
    byState: index('uat_sessions_state_idx').on(t.state),
    byProject: index('uat_sessions_project_idx').on(t.projectId),
  }),
)

export type UATSessionRow = typeof uatSessions.$inferSelect
export type UATSessionInsert = typeof uatSessions.$inferInsert

// AssumptionItem type — mirrors TRD-11 §4.6 AssumptionItemSchema
export interface AssumptionItem {
  assumption_id: string
  source: 'vision' | 'worker'
  text: string
  context?: string
  recorded_by_persona_id?: string
  recorded_at: string
  task_id?: string
}

// ---------------------------------------------------------------------------
// uat_ac_results
// ---------------------------------------------------------------------------

/**
 * Per TRD-11 v0.2 §4.2.
 *
 * One row per AC per session. ac_text_snapshot is frozen at session start so
 * historical records remain stable even if the story is later re-decomposed.
 * UNIQUE (uat_session_id, ac_id) enforced via constraint.
 *
 * evidence_links: structured references to screenshots, logs, video, audit
 * events, or channel posts supporting the result.
 */
export const uatAcResults = pgTable(
  'uat_ac_results',
  {
    acResultId: uuid('ac_result_id').primaryKey(),
    uatSessionId: uuid('uat_session_id')
      .notNull()
      .references(() => uatSessions.uatSessionId),
    acId: uuid('ac_id').notNull(),
    acOrdinal: integer('ac_ordinal').notNull(),
    acTextSnapshot: text('ac_text_snapshot').notNull(),
    status: text('status', { enum: UAT_AC_STATUS }).notNull().default('pending'),
    observedBehavior: text('observed_behavior'),
    evidenceLinks: jsonb('evidence_links')
      .$type<
        Array<{
          type: 'screenshot' | 'log' | 'video' | 'audit_event' | 'channel_post'
          uri: string
          label?: string
        }>
      >()
      .notNull()
      .default([]),
    markedAt: timestamp('marked_at', { withTimezone: true, mode: 'date' }),
    markedByUserId: text('marked_by_user_id'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    bySession: index('uat_ac_results_session_idx').on(t.uatSessionId),
    uniqPerAcPerSession: unique('uat_ac_results_session_ac_uniq').on(t.uatSessionId, t.acId),
  }),
)

export type UATACResultRow = typeof uatAcResults.$inferSelect
export type UATACResultInsert = typeof uatAcResults.$inferInsert

// ---------------------------------------------------------------------------
// defects
// ---------------------------------------------------------------------------

/**
 * Per TRD-11 v0.2 §4.3.
 *
 * One defect per failed AC (rationale in §8.1). eight-state lifecycle per §7.3.
 *
 * fixing_ticket_id: NULL until TRD-02 creates the fix story and populates this.
 * preempts_sprint: non-null sprint_id if this defect triggered sprint preemption.
 */
export const defects = pgTable(
  'defects',
  {
    defectId: uuid('defect_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    defectKey: text('defect_key').notNull().unique(),
    originStoryId: uuid('origin_story_id').notNull(),
    originAcId: uuid('origin_ac_id').notNull(),
    // Round 6 #3: nullable to support operator-reported defects (no formal UAT session).
    // Existing defects from formal sessions retain non-null values.
    uatSessionId: uuid('uat_session_id')
      .references(() => uatSessions.uatSessionId),
    // Round 6 #3: nullable for operator-reported defects (no formal AC result row).
    acResultId: uuid('ac_result_id')
      .references(() => uatAcResults.acResultId),
    personaOfRecordId: text('persona_of_record_id').notNull(),
    title: text('title').notNull(),
    observedBehavior: text('observed_behavior').notNull(),
    expectedBehavior: text('expected_behavior').notNull(),
    severity: text('severity', { enum: DEFECT_SEVERITY }).notNull(),
    state: text('state', { enum: DEFECT_STATE }).notNull().default('open'),
    preemptsSprint: text('preempts_sprint'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    reopenCount: integer('reopen_count').notNull().default(0),
    // Populated by TRD-02 defect-promotion handler; NULL until promoted.
    fixingTicketId: uuid('fixing_ticket_id'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    byOrigin: index('defects_origin_idx').on(t.originStoryId),
    byPersona: index('defects_persona_idx').on(t.personaOfRecordId),
    bySession: index('defects_session_idx').on(t.uatSessionId),
    bySeverity: index('defects_severity_idx').on(t.severity, t.state),
  }),
)

export type DefectRow = typeof defects.$inferSelect
export type DefectInsert = typeof defects.$inferInsert

// ---------------------------------------------------------------------------
// defect_lineage
// ---------------------------------------------------------------------------

/**
 * Per TRD-11 v0.2 §4.4.
 *
 * Materialised lineage breadcrumbs frozen at defect creation. One row per defect
 * (UNIQUE constraint). Preserves the vision→epic→story chain as it existed when
 * the defect was filed — upstream revisions do not affect historical records.
 */
export const defectLineage = pgTable('defect_lineage', {
  defectLineageId: uuid('defect_lineage_id').primaryKey(),
  defectId: uuid('defect_id')
    .notNull()
    .references(() => defects.defectId)
    .unique(),
  visionDocumentId: uuid('vision_document_id').notNull(),
  visionVersion: integer('vision_version').notNull(),
  epicId: uuid('epic_id').notNull(),
  storyId: uuid('story_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  taskIds: jsonb('task_ids').$type<string[]>().notNull(),
  workerSessionIds: jsonb('worker_session_ids').$type<string[]>().notNull(),
  primaryAuditEventIds: jsonb('primary_audit_event_ids').$type<string[]>().notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  schemaVersion: integer('schema_version').notNull().default(1),
})

export type DefectLineageRow = typeof defectLineage.$inferSelect
export type DefectLineageInsert = typeof defectLineage.$inferInsert

// ---------------------------------------------------------------------------
// persona_of_record_links
// ---------------------------------------------------------------------------

/**
 * Per TRD-11 v0.2 §4.5.
 *
 * Maps a story (via its tasks) to the persona that owned a piece of work.
 * Written by TRD-04 at task close; read by UAT defect creation.
 * The carry-forward algorithm (§8.2) is implemented in persona-of-record.ts.
 */
export const personaOfRecordLinks = pgTable(
  'persona_of_record_links',
  {
    porLinkId: uuid('por_link_id').primaryKey(),
    storyId: uuid('story_id').notNull(),
    acId: uuid('ac_id'),
    personaId: text('persona_id').notNull(),
    role: text('role', { enum: POR_ROLE }).notNull(),
    taskId: uuid('task_id').notNull(),
    workerSessionId: uuid('worker_session_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    byStory: index('por_links_story_idx').on(t.storyId, t.role),
    byPersona: index('por_links_persona_idx').on(t.personaId),
    byStoryAc: index('por_links_story_ac_idx').on(t.storyId, t.acId),
  }),
)

export type PersonaOfRecordLinkRow = typeof personaOfRecordLinks.$inferSelect
export type PersonaOfRecordLinkInsert = typeof personaOfRecordLinks.$inferInsert
