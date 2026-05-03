/**
 * retros.ts - Drizzle schema for Phase 5B retro tables.
 *
 * Per TRD-10 v0.1 §4.
 *
 * Owned tables (this file):
 *   - retro_reports
 *   - retro_analyses
 *   - retro_proposals
 *   - retro_proposal_layers
 *   - system_versions
 *   - system_version_diffs
 *   - retro_outcomes
 *
 * Cross-context references (NOT redefined here):
 *   - sprints.sprint_id, sprint_commitments.sprint_id are owned by Phase 4B
 *     (db/schema/backlog.ts). retro_reports.sprint_id and proposal/outcome
 *     references to sprint_id are nullable uuids without physical FKs.
 *   - The additive sprint_commitments.system_version_id column is added by
 *     migration 0012_retros.sql but NOT redeclared in the Drizzle schema —
 *     Phase 4B owns the canonical typed column set; the migration is the
 *     additive evidence. RetroService reads this column via raw SQL only.
 *
 * Within-context FKs (real, enforced):
 *   - retro_analyses.retro_report_id -> retro_reports.retro_report_id
 *   - retro_proposals.retro_report_id -> retro_reports.retro_report_id
 *   - retro_proposal_layers.retro_proposal_id -> retro_proposals.retro_proposal_id (CASCADE)
 *   - system_version_diffs.system_version_id -> system_versions.system_version_id
 *   - system_version_diffs.retro_proposal_id -> retro_proposals.retro_proposal_id (nullable)
 *   - retro_outcomes.retro_proposal_id -> retro_proposals.retro_proposal_id
 *   - retro_outcomes.system_version_id -> system_versions.system_version_id
 */
import { pgTable, uuid, text, integer, jsonb, boolean, timestamp, index, uniqueIndex, } from 'drizzle-orm/pg-core';
// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------
export const RETRO_REPORT_STATUS = [
    'analyzing',
    'ready',
    'reviewing',
    'closed',
    'failed',
];
export const PROPOSAL_LAYER = [
    'persona',
    'skill',
    'hook',
    'routing',
    'ceremony',
    'orchestrator',
    'environment',
    'board',
];
export const PROPOSAL_STATUS = [
    'pending',
    'approved',
    'rejected',
    'deferred',
    'merged',
    'rolled_back',
];
export const PROPOSAL_CHANGE_TYPE = ['create', 'modify', 'delete'];
export const VERSION_DIFF_CHANGE_TYPE = ['added', 'modified', 'deleted'];
export const EXPECTED_DIRECTION = ['increase', 'decrease'];
// ---------------------------------------------------------------------------
// retro_reports
// ---------------------------------------------------------------------------
export const retroReports = pgTable('retro_reports', {
    retroReportId: uuid('retro_report_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    sprintId: uuid('sprint_id').notNull(),
    systemVersionId: uuid('system_version_id'),
    analysisRunSeq: integer('analysis_run_seq').notNull().default(1),
    status: text('status', { enum: RETRO_REPORT_STATUS }).notNull().default('analyzing'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    proposalCount: integer('proposal_count').notNull().default(0),
    approvedCount: integer('approved_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    deferredCount: integer('deferred_count').notNull().default(0),
    retroOnRetroAccuracy: integer('retro_on_retro_accuracy'),
    failureReason: text('failure_reason'),
    createdEventId: uuid('created_event_id').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    bySprintRun: uniqueIndex('retro_reports_sprint_run_uq').on(t.sprintId, t.analysisRunSeq),
    byVersion: index('retro_reports_version_idx').on(t.systemVersionId),
    byStatus: index('retro_reports_status_idx').on(t.status),
}));
// ---------------------------------------------------------------------------
// retro_analyses
// ---------------------------------------------------------------------------
export const retroAnalyses = pgTable('retro_analyses', {
    retroAnalysisId: uuid('retro_analysis_id').primaryKey(),
    retroReportId: uuid('retro_report_id')
        .notNull()
        .references(() => retroReports.retroReportId),
    metricKey: text('metric_key').notNull(),
    metricValue: jsonb('metric_value').notNull(),
    prevSprintValue: jsonb('prev_sprint_value'),
    pctDelta: integer('pct_delta'),
    flagged: boolean('flagged').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    queryTraceRef: text('query_trace_ref'),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byReport: index('retro_analyses_report_idx').on(t.retroReportId),
    byMetric: uniqueIndex('retro_analyses_metric_uq').on(t.retroReportId, t.metricKey),
}));
// ---------------------------------------------------------------------------
// retro_proposals
// ---------------------------------------------------------------------------
export const retroProposals = pgTable('retro_proposals', {
    retroProposalId: uuid('retro_proposal_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    retroReportId: uuid('retro_report_id')
        .notNull()
        .references(() => retroReports.retroReportId),
    proposalCode: text('proposal_code').notNull(),
    title: text('title').notNull(),
    hypothesis: text('hypothesis').notNull(),
    expectedImpactMetric: text('expected_impact_metric').notNull(),
    expectedImpactDirection: text('expected_impact_direction', {
        enum: EXPECTED_DIRECTION,
    }).notNull(),
    expectedImpactPctPoints: integer('expected_impact_pct_points').notNull(),
    expectedImpactCi: jsonb('expected_impact_ci').$type(),
    rollbackPath: text('rollback_path').notNull(),
    evidenceRefs: jsonb('evidence_refs')
        .$type()
        .notNull()
        .default([]),
    appliesToSprintId: uuid('applies_to_sprint_id'),
    isGlobal: boolean('is_global').notNull().default(false),
    currentValue: jsonb('current_value'),
    proposedValue: jsonb('proposed_value'),
    confidenceScore: integer('confidence_score').notNull().default(50),
    status: text('status', { enum: PROPOSAL_STATUS }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionRationale: text('decision_rationale'),
    prRef: text('pr_ref'),
    mergedSystemVersionId: uuid('merged_system_version_id'),
    deferredFromProposalId: uuid('deferred_from_proposal_id'),
    createdEventId: uuid('created_event_id').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byReport: index('retro_proposals_report_idx').on(t.retroReportId),
    byStatus: index('retro_proposals_status_idx').on(t.status),
    byCode: uniqueIndex('retro_proposals_code_uq').on(t.proposalCode),
}));
// ---------------------------------------------------------------------------
// retro_proposal_layers
// ---------------------------------------------------------------------------
export const retroProposalLayers = pgTable('retro_proposal_layers', {
    retroProposalLayerId: uuid('retro_proposal_layer_id').primaryKey(),
    retroProposalId: uuid('retro_proposal_id')
        .notNull()
        .references(() => retroProposals.retroProposalId, { onDelete: 'cascade' }),
    layer: text('layer', { enum: PROPOSAL_LAYER }).notNull(),
    targetPath: text('target_path').notNull(),
    changeType: text('change_type', { enum: PROPOSAL_CHANGE_TYPE }).notNull(),
    diffPreview: text('diff_preview'),
    isDominant: boolean('is_dominant').notNull().default(false),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byProposal: index('retro_proposal_layers_proposal_idx').on(t.retroProposalId),
    byLayer: index('retro_proposal_layers_layer_idx').on(t.layer),
}));
// ---------------------------------------------------------------------------
// system_versions
// ---------------------------------------------------------------------------
export const systemVersions = pgTable('system_versions', {
    systemVersionId: uuid('system_version_id').primaryKey(),
    versionNumber: text('version_number').notNull(),
    parentSystemVersionId: uuid('parent_system_version_id'),
    gitTag: text('git_tag').notNull(),
    gitSha: text('git_sha').notNull(),
    shippedAt: timestamp('shipped_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    shippedBy: text('shipped_by').notNull(),
    isRollback: boolean('is_rollback').notNull().default(false),
    rolledBackVersionId: uuid('rolled_back_version_id'),
    retroReportId: uuid('retro_report_id'),
    notes: text('notes'),
    createdEventId: uuid('created_event_id').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byNumber: uniqueIndex('system_versions_number_uq').on(t.versionNumber),
    byTag: uniqueIndex('system_versions_tag_uq').on(t.gitTag),
    byParent: index('system_versions_parent_idx').on(t.parentSystemVersionId),
    byReport: index('system_versions_retro_idx').on(t.retroReportId),
}));
// ---------------------------------------------------------------------------
// system_version_diffs
// ---------------------------------------------------------------------------
export const systemVersionDiffs = pgTable('system_version_diffs', {
    systemVersionDiffId: uuid('system_version_diff_id').primaryKey(),
    systemVersionId: uuid('system_version_id')
        .notNull()
        .references(() => systemVersions.systemVersionId),
    retroProposalId: uuid('retro_proposal_id').references(() => retroProposals.retroProposalId),
    layer: text('layer').notNull(),
    filePath: text('file_path').notNull(),
    changeType: text('change_type', { enum: VERSION_DIFF_CHANGE_TYPE }).notNull(),
    unifiedDiff: text('unified_diff').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byVersion: index('system_version_diffs_version_idx').on(t.systemVersionId),
    byProposal: index('system_version_diffs_proposal_idx').on(t.retroProposalId),
}));
// ---------------------------------------------------------------------------
// retro_outcomes
// ---------------------------------------------------------------------------
export const retroOutcomes = pgTable('retro_outcomes', {
    retroOutcomeId: uuid('retro_outcome_id').primaryKey(),
    retroProposalId: uuid('retro_proposal_id')
        .notNull()
        .references(() => retroProposals.retroProposalId),
    systemVersionId: uuid('system_version_id')
        .notNull()
        .references(() => systemVersions.systemVersionId),
    metricKey: text('metric_key').notNull(),
    expectedDirection: text('expected_direction', { enum: EXPECTED_DIRECTION }).notNull(),
    expectedPctPoints: integer('expected_pct_points').notNull(),
    windowSprintCount: integer('window_sprint_count').notNull().default(2),
    windowStartSprintId: uuid('window_start_sprint_id'),
    windowEndSprintId: uuid('window_end_sprint_id'),
    baselineValue: jsonb('baseline_value'),
    actualPctPoints: integer('actual_pct_points'),
    toleranceBand: integer('tolerance_band').notNull().default(500),
    matchedExpectation: boolean('matched_expectation'),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }),
    recordedEventId: uuid('recorded_event_id'),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    byProposal: index('retro_outcomes_proposal_idx').on(t.retroProposalId),
    byVersion: index('retro_outcomes_version_idx').on(t.systemVersionId),
}));
//# sourceMappingURL=retros.js.map