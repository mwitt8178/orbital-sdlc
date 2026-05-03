/**
 * Drizzle schemas for drift_events, reconciliation_runs, and audit_query_cache.
 *
 * Per TRD-07 §4.2 and §4.3. Service logic (reconciliation algorithm, query
 * cache population) is owned by Phase 4C; these are schema stubs only.
 *
 * Unlike audit.events, drift_events IS mutable (resolution fields are updated).
 * It does NOT carry the append-only trigger.
 */
import { pgSchema, uuid, text, jsonb, integer, index, timestamp, } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
export const audit = pgSchema('audit');
// ---------------------------------------------------------------------------
// reconciliation_runs
// ---------------------------------------------------------------------------
/**
 * One row per reconciliation run (scheduled or on-demand).
 * Status transitions: running → completed | failed.
 * Concurrency enforced by pg_try_advisory_lock per TRD-07 §7.6.
 */
export const reconciliationRuns = audit.table('reconciliation_runs', {
    runId: uuid('run_id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    trigger: text('trigger').notNull(), // 'scheduled' | 'on_demand'
    triggeredBy: jsonb('triggered_by').notNull(), // ActorSchema
    windowFrom: timestamp('window_from', { withTimezone: true, mode: 'string' }).notNull(),
    windowTo: timestamp('window_to', { withTimezone: true, mode: 'string' }).notNull(),
    gitCommitsScanned: integer('git_commits_scanned').default(0).notNull(),
    worktreeFilesScanned: integer('worktree_files_scanned').default(0).notNull(),
    mondayItemsScanned: integer('monday_items_scanned').default(0).notNull(),
    driftEventsEmitted: integer('drift_events_emitted').default(0).notNull(),
    status: text('status').notNull(), // 'running' | 'completed' | 'failed'
    errorPayload: jsonb('error_payload'), // null unless status='failed'
}, (t) => ({
    startedIdx: index('reconciliation_runs_started_idx').on(t.startedAt),
}));
// ---------------------------------------------------------------------------
// drift_events
// ---------------------------------------------------------------------------
/**
 * One row per detected drift instance.
 * Mutable: resolution / resolutionNote / resolvedAt are updated by operator.
 * The durable record lives in audit.events (DriftDetected); this table is the index.
 */
export const driftEvents = audit.table('drift_events', {
    driftId: uuid('drift_id').primaryKey(),
    runId: uuid('run_id').notNull(), // FK → reconciliation_runs.run_id (no FK constraint per DSQL hard-no, but enforced at app layer)
    source: text('source').notNull(), // 'git' | 'worktree' | 'monday'
    driftKind: text('drift_kind').notNull(),
    observed: jsonb('observed').notNull(),
    expected: jsonb('expected'),
    severity: text('severity').notNull(), // 'info' | 'warning' | 'critical'
    detectedAt: timestamp('detected_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    detectionEventId: uuid('detection_event_id').notNull(),
    resolution: text('resolution'), // null | 'acknowledged' | 'remediated' | 'false_positive'
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
}, (t) => ({
    runIdx: index('drift_events_run_idx').on(t.runId),
    // Partial index on unresolved items for fast dashboard queries.
    unresolvedIdx: index('drift_events_unresolved_idx')
        .on(t.detectedAt)
        .where(sql `resolution IS NULL`),
}));
// ---------------------------------------------------------------------------
// audit_query_cache  (§4.3 — off by default, deferred)
// ---------------------------------------------------------------------------
/**
 * Optional cache for high-cost recurring queries.
 * Population and TTL strategy are deferred per TRD-07 §13 Q-7-2.
 * Flag: ORBITAL_AUDIT_QUERY_CACHE=on enables the lookup path.
 */
export const auditQueryCache = audit.table('audit_query_cache', {
    cacheKey: text('cache_key').primaryKey(), // hash(query_shape, filters)
    resultPage: jsonb('result_page').notNull(),
    totalEstimate: integer('total_estimate'),
    populatedAt: timestamp('populated_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    hitCount: integer('hit_count').default(0).notNull(),
});
//# sourceMappingURL=audit.js.map