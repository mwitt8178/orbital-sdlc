/**
 * vision/lifecycle.ts — Vision document state machine.
 *
 * Per TRD-01 §7.1: drafting → locked → revised (copy-on-write).
 *
 * Valid transitions:
 *   drafting  → locked   (vision.lock with confirmation_token + actor.type='user')
 *   locked    → revised  (vision.revise)
 *   revised   → revised  (further revisions)
 *   any       → abandoned (explicit; not enforced here)
 *
 * Invalid transitions emit CONFLICT_INVALID_STATE_TRANSITION per Primitives §10.
 */
export type VisionLifecycleState = 'drafting' | 'locked' | 'revised' | 'abandoned';
export type VisionLifecycle = {
    state: 'drafting';
    draft_version_id: string | null;
    open_session_id: string | null;
} | {
    state: 'locked';
    current_version_id: string;
    locked_at: string;
} | {
    state: 'revised';
    current_version_id: string;
    previous_locked_version_id: string;
    revised_at: string;
} | {
    state: 'abandoned';
    abandoned_at: string;
    reason: string;
};
/**
 * Assert that a document in `currentState` can transition to `targetState`.
 * Throws CONFLICT_INVALID_STATE_TRANSITION if the transition is not allowed.
 */
export declare function assertTransitionAllowed(currentState: VisionLifecycleState, targetState: VisionLifecycleState): void;
/**
 * Assert that a lock can be applied.
 * - Document must be in 'drafting' state.
 * - Actor must be type 'user' (FR-1.3).
 */
export declare function assertLockAllowed(currentState: VisionLifecycleState, actorType: string): void;
/**
 * Assert that a revision can be applied.
 * - Document must be in 'locked' or 'revised' state.
 * - Actor must be type 'user'.
 */
export declare function assertReviseAllowed(currentState: VisionLifecycleState, actorType: string): void;
import type { VisionDocumentContent } from './types.js';
/**
 * Validate a candidate content object for lock eligibility.
 * Returns a list of missing required fields and blocking open questions.
 * An empty result means the document is ready to lock.
 */
export interface LockValidationResult {
    missing_fields: string[];
    blocking_open_questions: string[];
    ready: boolean;
}
export declare function validateForLock(content: Partial<VisionDocumentContent> | Record<string, unknown>, attestation: {
    no_edge_cases: boolean;
}): LockValidationResult;
export declare function issueConfirmationToken(documentId: string): string;
export declare function consumeConfirmationToken(token: string, documentId: string): void;
/** Exported for tests to clear state between test cases. */
export declare function _clearTokenStore(): void;
export declare function computeContentHash(content: unknown): string;
//# sourceMappingURL=lifecycle.d.ts.map