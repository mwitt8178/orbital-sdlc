/**
 * orchestration/types.ts — Shared types for the orchestration subsystem.
 *
 * Per TRD-04 v0.2 §4 and §5.
 *
 * This module re-exports the row types from the Drizzle schema and adds the
 * thin domain helpers (state-machine guards, error codes, default budgets)
 * that other orchestration modules depend on.
 */
import { z } from 'zod';
export type { TaskRow, TaskInsert, TaskDependencyRow, TaskDependencyInsert, WorktreeRow, WorktreeInsert, RetryAttemptRow, RetryAttemptInsert, EscalationRow, EscalationInsert, WorkerPoolStateRow, AgentWorkerRow, WorkerHeartbeatRow, } from '../db/schema/orchestration.js';
export declare const TaskStateSchema: z.ZodEnum<["pending", "ready", "in_progress", "in_review", "blocked", "failed", "escalated", "done"]>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export declare const RiskClassSchema: z.ZodEnum<["low", "standard", "high", "critical"]>;
export type RiskClass = z.infer<typeof RiskClassSchema>;
export declare const DependencyTypeSchema: z.ZodEnum<["explicit", "file_based", "implicit"]>;
export type DependencyType = z.infer<typeof DependencyTypeSchema>;
export declare const WorktreeStateSchema: z.ZodEnum<["creating", "active", "draining", "cleaning", "released"]>;
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;
export declare const EscalationReasonSchema: z.ZodEnum<["retry_budget_exhausted", "timeout_after_retries", "blocker_unresolvable", "disagreement_unresolvable", "hook_rejected_critical", "manual_admin_kill"]>;
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;
export declare const EscalationStateSchema: z.ZodEnum<["open", "acknowledged", "resolved", "cancelled"]>;
export type EscalationState = z.infer<typeof EscalationStateSchema>;
/**
 * A sprint as the orchestrator sees it. The authoritative state machine is in
 * TRD-02; we only need priority/weight here for the multi-sprint scheduler's
 * weighted equal-share allocation.
 */
export interface SchedulerSprint {
    sprintId: string;
    /** 1..5 priority scale per TRD-02 / TRD-04 §17 O1 mapping. */
    priority: 1 | 2 | 3 | 4 | 5;
}
/** Default per-persona retry budget when persona escalation policy is silent. */
export declare const DEFAULT_RETRY_BUDGET = 3;
/** Default wall-clock timeout per task (TRD-04 §13). */
export declare const DEFAULT_WALL_CLOCK_TIMEOUT_MS: number;
/** Default token budget when routing decision is unavailable. */
export declare const DEFAULT_TOKEN_BUDGET = 8000;
/** Heartbeat-stale threshold per TRD-04 §13 (90s = 3 × 30s heartbeat interval). */
export declare const HEARTBEAT_TIMEOUT_MS: number;
/** Drain grace per TRD-04 §12.2 — workers exceeding this are force-killed. */
export declare const DRAIN_GRACE_MS: number;
/** SIGTERM-then-SIGKILL grace (TRD-04 §13.1). */
export declare const KILL_GRACE_MS: number;
/** Maximum retry backoff cap (the implementation caps at 60s). */
export declare const RETRY_BACKOFF_MAX_MS: number;
/** Base retry backoff before exponentiation. */
export declare const RETRY_BACKOFF_BASE_MS = 1000;
export declare const ORCHESTRATION_ERROR_CODES: {
    readonly NOT_FOUND_TASK: "NOT_FOUND_TASK";
    readonly NOT_FOUND_WORKER: "NOT_FOUND_WORKER";
    readonly CONFLICT_INVALID_STATE_TRANSITION: "CONFLICT_INVALID_STATE_TRANSITION";
    readonly CONFLICT_FILE_LOCKED: "CONFLICT_FILE_LOCKED";
    readonly CONFLICT_WORKTREE_ACTIVE: "CONFLICT_WORKTREE_ACTIVE";
    readonly TIMEOUT_TASK: "TIMEOUT_TASK";
    readonly TIMEOUT_HEARTBEAT: "TIMEOUT_HEARTBEAT";
    readonly TIMEOUT_TOKEN_BUDGET: "TIMEOUT_TOKEN_BUDGET";
    readonly TIMEOUT_SPAWN_GRACE: "TIMEOUT_SPAWN_GRACE";
    readonly TIMEOUT_DRAIN: "TIMEOUT_DRAIN";
    readonly INTERNAL_DAG_CYCLE: "INTERNAL_DAG_CYCLE";
    readonly INTERNAL_SPAWN_ABORTED: "INTERNAL_SPAWN_ABORTED";
    readonly CLAUDE_BIN_NOT_FOUND: "CLAUDE_BIN_NOT_FOUND";
    readonly AUTH_INVALID_CAPABILITY: "AUTH_INVALID_CAPABILITY";
    readonly HOOK_REJECTED_PRE_SPAWN: "HOOK_REJECTED_PRE_SPAWN";
};
export type OrchestrationErrorCode = (typeof ORCHESTRATION_ERROR_CODES)[keyof typeof ORCHESTRATION_ERROR_CODES];
/** Per TRD-04 §11.2: codes that are never retried. */
export declare const NON_RETRYABLE_CODES: Set<string>;
export declare function isNonRetryable(errorCode: string): boolean;
/** Returns true iff the (from -> to) transition is allowed by the state machine. */
export declare function isValidTaskTransition(from: TaskState, to: TaskState): boolean;
export declare const CAPABILITY_FILE_RELATIVE_PATH = ".orbital/capability.json";
//# sourceMappingURL=types.d.ts.map