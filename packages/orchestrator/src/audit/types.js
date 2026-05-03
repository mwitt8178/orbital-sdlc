/**
 * audit/types.ts — shared types for the audit subsystem (Phase 4C).
 *
 * Per TRD-07 §5.1 (event payload schemas owned by this TRD) and §4.2 (drift
 * and reconciliation tables).
 *
 * No schemas from other TRDs are redefined here.
 */
import { z } from 'zod';
import { AggregateTypeSchema } from '@orbital/types';
// ---------------------------------------------------------------------------
// Drift kinds — per TRD-07 §7.4
// ---------------------------------------------------------------------------
export const DriftKindSchema = z.enum([
    'commit_without_event',
    'event_without_commit',
    'file_change_without_event',
    'event_without_file_change',
    'monday_status_without_event',
    'event_without_monday_status',
    'capability_grant_without_use',
]);
export const DriftSourceSchema = z.enum(['git', 'worktree', 'monday', 'internal']);
export const DriftSeveritySchema = z.enum(['info', 'warning', 'critical']);
// ---------------------------------------------------------------------------
// DriftDetected payload — per TRD-07 §5.1
// ---------------------------------------------------------------------------
export const DriftDetectedPayloadV1 = z.object({
    drift_id: z.string(), // UUIDv7, FK to drift_events.drift_id
    run_id: z.string(), // UUIDv7
    source: DriftSourceSchema,
    drift_kind: DriftKindSchema,
    observed: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()).nullable(),
    severity: DriftSeveritySchema,
});
// ---------------------------------------------------------------------------
// ReconciliationRunStarted payload — per TRD-07 §5.1
// ---------------------------------------------------------------------------
export const ReconciliationRunStartedPayloadV1 = z.object({
    run_id: z.string(),
    trigger: z.enum(['scheduled', 'on_demand']),
    window_from: z.string().datetime(),
    window_to: z.string().datetime(),
});
// ---------------------------------------------------------------------------
// ReconciliationRunCompleted payload — per TRD-07 §5.1
// ---------------------------------------------------------------------------
export const ReconciliationRunCompletedPayloadV1 = z.object({
    run_id: z.string(),
    duration_ms: z.number().int().nonnegative(),
    git_commits_scanned: z.number().int().nonnegative(),
    worktree_files_scanned: z.number().int().nonnegative(),
    monday_items_scanned: z.number().int().nonnegative(),
    drift_events_emitted: z.number().int().nonnegative(),
    status: z.enum(['completed', 'failed']),
    error_payload: z.record(z.string(), z.unknown()).nullable(),
});
// ---------------------------------------------------------------------------
// AuditQueryExecuted payload — per TRD-07 §5.1
// ---------------------------------------------------------------------------
export const AuditQueryExecutedPayloadV1 = z.object({
    query_shape: z.string(),
    filters: z.record(z.string(), z.unknown()),
    rows_returned: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
});
// ---------------------------------------------------------------------------
// AuditQueryFilter — comprehensive filter for the query API
// Per TRD-07 §6.1.1
// ---------------------------------------------------------------------------
export const AuditQueryFilterSchema = z.object({
    aggregate_type: AggregateTypeSchema.optional(),
    aggregate_id: z.string().optional(),
    event_types: z.array(z.string()).optional(), // OR semantics (TRD-07 §6.1.1)
    event_type: z.string().optional(), // Single event_type (convenience alias)
    actor_type: z.enum(['persona', 'user', 'system', 'hook']).optional(),
    actor_id: z.string().optional(),
    occurred_from: z.string().datetime().optional(),
    occurred_to: z.string().datetime().optional(),
    trace_id: z.string().optional(),
    after: z.string().optional(), // cursor
    limit: z.number().int().min(1).max(1000).default(100),
});
//# sourceMappingURL=types.js.map