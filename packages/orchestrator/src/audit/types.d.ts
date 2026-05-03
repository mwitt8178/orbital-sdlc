/**
 * audit/types.ts — shared types for the audit subsystem (Phase 4C).
 *
 * Per TRD-07 §5.1 (event payload schemas owned by this TRD) and §4.2 (drift
 * and reconciliation tables).
 *
 * No schemas from other TRDs are redefined here.
 */
import { z } from 'zod';
import type { EventEnvelope, PaginatedResponse } from '@orbital/types';
export declare const DriftKindSchema: z.ZodEnum<["commit_without_event", "event_without_commit", "file_change_without_event", "event_without_file_change", "monday_status_without_event", "event_without_monday_status", "capability_grant_without_use"]>;
export type DriftKind = z.infer<typeof DriftKindSchema>;
export declare const DriftSourceSchema: z.ZodEnum<["git", "worktree", "monday", "internal"]>;
export type DriftSource = z.infer<typeof DriftSourceSchema>;
export declare const DriftSeveritySchema: z.ZodEnum<["info", "warning", "critical"]>;
export type DriftSeverity = z.infer<typeof DriftSeveritySchema>;
export declare const DriftDetectedPayloadV1: z.ZodObject<{
    drift_id: z.ZodString;
    run_id: z.ZodString;
    source: z.ZodEnum<["git", "worktree", "monday", "internal"]>;
    drift_kind: z.ZodEnum<["commit_without_event", "event_without_commit", "file_change_without_event", "event_without_file_change", "monday_status_without_event", "event_without_monday_status", "capability_grant_without_use"]>;
    observed: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    expected: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    severity: z.ZodEnum<["info", "warning", "critical"]>;
}, "strip", z.ZodTypeAny, {
    expected: Record<string, unknown> | null;
    run_id: string;
    drift_id: string;
    source: "monday" | "git" | "worktree" | "internal";
    drift_kind: "commit_without_event" | "event_without_commit" | "file_change_without_event" | "event_without_file_change" | "monday_status_without_event" | "event_without_monday_status" | "capability_grant_without_use";
    observed: Record<string, unknown>;
    severity: "info" | "critical" | "warning";
}, {
    expected: Record<string, unknown> | null;
    run_id: string;
    drift_id: string;
    source: "monday" | "git" | "worktree" | "internal";
    drift_kind: "commit_without_event" | "event_without_commit" | "file_change_without_event" | "event_without_file_change" | "monday_status_without_event" | "event_without_monday_status" | "capability_grant_without_use";
    observed: Record<string, unknown>;
    severity: "info" | "critical" | "warning";
}>;
export type DriftDetectedPayload = z.infer<typeof DriftDetectedPayloadV1>;
export declare const ReconciliationRunStartedPayloadV1: z.ZodObject<{
    run_id: z.ZodString;
    trigger: z.ZodEnum<["scheduled", "on_demand"]>;
    window_from: z.ZodString;
    window_to: z.ZodString;
}, "strip", z.ZodTypeAny, {
    run_id: string;
    trigger: "scheduled" | "on_demand";
    window_from: string;
    window_to: string;
}, {
    run_id: string;
    trigger: "scheduled" | "on_demand";
    window_from: string;
    window_to: string;
}>;
export type ReconciliationRunStartedPayload = z.infer<typeof ReconciliationRunStartedPayloadV1>;
export declare const ReconciliationRunCompletedPayloadV1: z.ZodObject<{
    run_id: z.ZodString;
    duration_ms: z.ZodNumber;
    git_commits_scanned: z.ZodNumber;
    worktree_files_scanned: z.ZodNumber;
    monday_items_scanned: z.ZodNumber;
    drift_events_emitted: z.ZodNumber;
    status: z.ZodEnum<["completed", "failed"]>;
    error_payload: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    status: "failed" | "completed";
    run_id: string;
    git_commits_scanned: number;
    worktree_files_scanned: number;
    monday_items_scanned: number;
    drift_events_emitted: number;
    error_payload: Record<string, unknown> | null;
    duration_ms: number;
}, {
    status: "failed" | "completed";
    run_id: string;
    git_commits_scanned: number;
    worktree_files_scanned: number;
    monday_items_scanned: number;
    drift_events_emitted: number;
    error_payload: Record<string, unknown> | null;
    duration_ms: number;
}>;
export type ReconciliationRunCompletedPayload = z.infer<typeof ReconciliationRunCompletedPayloadV1>;
export declare const AuditQueryExecutedPayloadV1: z.ZodObject<{
    query_shape: z.ZodString;
    filters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    rows_returned: z.ZodNumber;
    duration_ms: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    duration_ms: number;
    query_shape: string;
    filters: Record<string, unknown>;
    rows_returned: number;
}, {
    duration_ms: number;
    query_shape: string;
    filters: Record<string, unknown>;
    rows_returned: number;
}>;
export type AuditQueryExecutedPayload = z.infer<typeof AuditQueryExecutedPayloadV1>;
export interface DriftDetail {
    source: DriftSource;
    drift_kind: DriftKind;
    observed: Record<string, unknown>;
    expected: Record<string, unknown> | null;
    severity: DriftSeverity;
}
export interface ReconciliationReport {
    run_id: string;
    window_from: string;
    window_to: string;
    duration_ms: number;
    git_commits_scanned: number;
    worktree_files_scanned: number;
    monday_items_scanned: number;
    drift_events_emitted: number;
    status: 'completed' | 'failed';
    error_payload: Record<string, unknown> | null;
}
export declare const AuditQueryFilterSchema: z.ZodObject<{
    aggregate_type: z.ZodOptional<z.ZodEnum<["task", "sprint", "ticket", "vision_document", "persona", "capability", "channel", "channel_post", "ceremony", "disagreement", "retro", "defect", "adr", "install", "system", "verification", "audit_export", "cost_accounting_period", "system_version", "hook_invocation", "orchestration", "reconciliation_run", "monday_sync", "epic", "story", "uat_session", "presence"]>>;
    aggregate_id: z.ZodOptional<z.ZodString>;
    event_types: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    event_type: z.ZodOptional<z.ZodString>;
    actor_type: z.ZodOptional<z.ZodEnum<["persona", "user", "system", "hook"]>>;
    actor_id: z.ZodOptional<z.ZodString>;
    occurred_from: z.ZodOptional<z.ZodString>;
    occurred_to: z.ZodOptional<z.ZodString>;
    trace_id: z.ZodOptional<z.ZodString>;
    after: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    trace_id?: string | undefined;
    aggregate_id?: string | undefined;
    aggregate_type?: "task" | "sprint" | "system" | "persona" | "retro" | "adr" | "channel_post" | "ticket" | "channel" | "epic" | "ceremony" | "defect" | "vision_document" | "capability" | "disagreement" | "install" | "verification" | "audit_export" | "cost_accounting_period" | "system_version" | "hook_invocation" | "orchestration" | "reconciliation_run" | "monday_sync" | "story" | "uat_session" | "presence" | undefined;
    event_type?: string | undefined;
    after?: string | undefined;
    event_types?: string[] | undefined;
    actor_type?: "user" | "system" | "persona" | "hook" | undefined;
    actor_id?: string | undefined;
    occurred_from?: string | undefined;
    occurred_to?: string | undefined;
}, {
    limit?: number | undefined;
    trace_id?: string | undefined;
    aggregate_id?: string | undefined;
    aggregate_type?: "task" | "sprint" | "system" | "persona" | "retro" | "adr" | "channel_post" | "ticket" | "channel" | "epic" | "ceremony" | "defect" | "vision_document" | "capability" | "disagreement" | "install" | "verification" | "audit_export" | "cost_accounting_period" | "system_version" | "hook_invocation" | "orchestration" | "reconciliation_run" | "monday_sync" | "story" | "uat_session" | "presence" | undefined;
    event_type?: string | undefined;
    after?: string | undefined;
    event_types?: string[] | undefined;
    actor_type?: "user" | "system" | "persona" | "hook" | undefined;
    actor_id?: string | undefined;
    occurred_from?: string | undefined;
    occurred_to?: string | undefined;
}>;
export type AuditQueryFilter = z.infer<typeof AuditQueryFilterSchema>;
export type { EventEnvelope, PaginatedResponse };
//# sourceMappingURL=types.d.ts.map