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
// ---------------------------------------------------------------------------
// State enums (mirrored as Zod for runtime validation)
// ---------------------------------------------------------------------------
export const TaskStateSchema = z.enum([
    'pending',
    'ready',
    'in_progress',
    'in_review',
    'blocked',
    'failed',
    'escalated',
    'done',
]);
export const RiskClassSchema = z.enum(['low', 'standard', 'high', 'critical']);
export const DependencyTypeSchema = z.enum(['explicit', 'file_based', 'implicit']);
export const WorktreeStateSchema = z.enum([
    'creating',
    'active',
    'draining',
    'cleaning',
    'released',
]);
export const EscalationReasonSchema = z.enum([
    'retry_budget_exhausted',
    'timeout_after_retries',
    'blocker_unresolvable',
    'disagreement_unresolvable',
    'hook_rejected_critical',
    'manual_admin_kill',
]);
export const EscalationStateSchema = z.enum([
    'open',
    'acknowledged',
    'resolved',
    'cancelled',
]);
// ---------------------------------------------------------------------------
// Configuration / defaults
// ---------------------------------------------------------------------------
/** Default per-persona retry budget when persona escalation policy is silent. */
export const DEFAULT_RETRY_BUDGET = 3;
/** Default wall-clock timeout per task (TRD-04 §13). */
export const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;
/** Default token budget when routing decision is unavailable. */
export const DEFAULT_TOKEN_BUDGET = 8000;
/** Heartbeat-stale threshold per TRD-04 §13 (90s = 3 × 30s heartbeat interval). */
export const HEARTBEAT_TIMEOUT_MS = 90 * 1000;
/** Drain grace per TRD-04 §12.2 — workers exceeding this are force-killed. */
export const DRAIN_GRACE_MS = 60 * 1000;
/** SIGTERM-then-SIGKILL grace (TRD-04 §13.1). */
export const KILL_GRACE_MS = 5 * 1000;
/** Maximum retry backoff cap (the implementation caps at 60s). */
export const RETRY_BACKOFF_MAX_MS = 60 * 1000;
/** Base retry backoff before exponentiation. */
export const RETRY_BACKOFF_BASE_MS = 1000;
// ---------------------------------------------------------------------------
// Error codes — TRD-04 §14 + a few orchestration-internals
// ---------------------------------------------------------------------------
export const ORCHESTRATION_ERROR_CODES = {
    NOT_FOUND_TASK: 'NOT_FOUND_TASK',
    NOT_FOUND_WORKER: 'NOT_FOUND_WORKER',
    CONFLICT_INVALID_STATE_TRANSITION: 'CONFLICT_INVALID_STATE_TRANSITION',
    CONFLICT_FILE_LOCKED: 'CONFLICT_FILE_LOCKED',
    CONFLICT_WORKTREE_ACTIVE: 'CONFLICT_WORKTREE_ACTIVE',
    TIMEOUT_TASK: 'TIMEOUT_TASK',
    TIMEOUT_HEARTBEAT: 'TIMEOUT_HEARTBEAT',
    TIMEOUT_TOKEN_BUDGET: 'TIMEOUT_TOKEN_BUDGET',
    TIMEOUT_SPAWN_GRACE: 'TIMEOUT_SPAWN_GRACE',
    TIMEOUT_DRAIN: 'TIMEOUT_DRAIN',
    INTERNAL_DAG_CYCLE: 'INTERNAL_DAG_CYCLE',
    INTERNAL_SPAWN_ABORTED: 'INTERNAL_SPAWN_ABORTED',
    CLAUDE_BIN_NOT_FOUND: 'CLAUDE_BIN_NOT_FOUND',
    AUTH_INVALID_CAPABILITY: 'AUTH_INVALID_CAPABILITY',
    HOOK_REJECTED_PRE_SPAWN: 'HOOK_REJECTED_PRE_SPAWN',
};
/** Per TRD-04 §11.2: codes that are never retried. */
export const NON_RETRYABLE_CODES = new Set([
    'AUTH_INVALID_CAPABILITY',
    'AUTH_SCOPE_DENIED',
    'AUTH_SOD_VIOLATION',
    'HOOK_REJECTED_PRE_MERGE',
    'BUDGET_SPRINT_EXCEEDED',
    // anything starting with INTERNAL_DATA_CORRUPTION_ — checked dynamically
]);
export function isNonRetryable(errorCode) {
    if (NON_RETRYABLE_CODES.has(errorCode))
        return true;
    if (errorCode.startsWith('INTERNAL_DATA_CORRUPTION_'))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Valid task transitions (matches TRD-04 §7.1 transition table)
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS = {
    pending: ['ready'],
    ready: ['in_progress'],
    in_progress: ['in_review', 'blocked', 'failed', 'escalated'],
    in_review: ['done', 'failed'],
    blocked: ['ready'],
    failed: ['ready', 'escalated'],
    escalated: ['ready'],
    done: [],
};
/** Returns true iff the (from -> to) transition is allowed by the state machine. */
export function isValidTaskTransition(from, to) {
    const allowed = VALID_TRANSITIONS[from];
    return allowed.includes(to);
}
// ---------------------------------------------------------------------------
// Capability-bundle JSON file shape (the file written to {worktree}/.orbital/capability.json)
// ---------------------------------------------------------------------------
export const CAPABILITY_FILE_RELATIVE_PATH = '.orbital/capability.json';
//# sourceMappingURL=types.js.map