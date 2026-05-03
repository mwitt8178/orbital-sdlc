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
import { OrbitalError } from '@orbital/types';
// ---------------------------------------------------------------------------
// Transition validators
// ---------------------------------------------------------------------------
/**
 * Assert that a document in `currentState` can transition to `targetState`.
 * Throws CONFLICT_INVALID_STATE_TRANSITION if the transition is not allowed.
 */
export function assertTransitionAllowed(currentState, targetState) {
    const allowed = ALLOWED_TRANSITIONS[currentState] ?? new Set();
    if (!allowed.has(targetState)) {
        throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `Vision document cannot transition from '${currentState}' to '${targetState}'`, { from: currentState, to: targetState }, 'no_retry');
    }
}
/**
 * Assert that a lock can be applied.
 * - Document must be in 'drafting' state.
 * - Actor must be type 'user' (FR-1.3).
 */
export function assertLockAllowed(currentState, actorType) {
    if (currentState !== 'drafting') {
        throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `Lock attempted on a document in '${currentState}' state. Only 'drafting' documents can be locked.`, { current_state: currentState }, 'no_retry');
    }
    if (actorType !== 'user') {
        throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', 'FR-1.3: vision.lock requires actor.type === \'user\'. Only a human can lock a vision document.', { actor_type: actorType }, 'no_retry');
    }
}
/**
 * Assert that a revision can be applied.
 * - Document must be in 'locked' or 'revised' state.
 * - Actor must be type 'user'.
 */
export function assertReviseAllowed(currentState, actorType) {
    if (currentState !== 'locked' && currentState !== 'revised') {
        throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', `Revise attempted on a document in '${currentState}' state. Only 'locked' or 'revised' documents can be revised.`, { current_state: currentState }, 'no_retry');
    }
    if (actorType !== 'user') {
        throw new OrbitalError('CONFLICT_INVALID_STATE_TRANSITION', 'vision.revise requires actor.type === \'user\'.', { actor_type: actorType }, 'no_retry');
    }
}
export function validateForLock(content, attestation) {
    const missing = [];
    const blockingQs = [];
    const c = content;
    // Required non-empty arrays (FR-1.2, FR-1.7)
    for (const field of ['goals', 'non_goals', 'target_users', 'acceptance_criteria']) {
        const arr = c[field];
        if (!Array.isArray(arr) || arr.length === 0) {
            missing.push(field);
        }
    }
    // Glossary and edge_cases are nice-to-have but not blocking for v1 lock.
    // They can be added through subsequent revisions. Keeping them required at
    // initial-lock time pushes too much friction onto the user — TRD-01 §6.1's
    // intent is that the locked vision is *trustworthy*, not *exhaustive*.
    // The attestation.no_edge_cases flag is now a soft signal carried in the
    // event payload rather than a hard gate.
    void attestation;
    // Open questions: blocking:true and unresolved
    const open_questions = c['open_questions'];
    if (Array.isArray(open_questions)) {
        for (const q of open_questions) {
            if (q['blocking'] === true && q['resolved_at'] === undefined) {
                blockingQs.push(q['id']);
            }
        }
    }
    return {
        missing_fields: missing,
        blocking_open_questions: blockingQs,
        ready: missing.length === 0 && blockingQs.length === 0,
    };
}
// ---------------------------------------------------------------------------
// Confirmation token helpers (FR-1.3, TRD-01 §8.4)
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from 'node:crypto';
const TOKEN_TTL_MS = 15 * 60 * 1000;
const _tokenStore = new Map();
export function issueConfirmationToken(documentId) {
    const token = randomBytes(32).toString('hex');
    _tokenStore.set(token, {
        documentId,
        expiresAt: Date.now() + TOKEN_TTL_MS,
        used: false,
    });
    return token;
}
export function consumeConfirmationToken(token, documentId) {
    const entry = _tokenStore.get(token);
    if (!entry) {
        throw new OrbitalError('CONFLICT_CONFIRMATION_TOKEN_USED', 'Confirmation token not found or already consumed.', { token: '[redacted]' }, 'no_retry');
    }
    if (entry.used) {
        throw new OrbitalError('CONFLICT_CONFIRMATION_TOKEN_USED', 'Confirmation token has already been used.', {}, 'no_retry');
    }
    if (Date.now() > entry.expiresAt) {
        _tokenStore.delete(token);
        throw new OrbitalError('CONFLICT_CONFIRMATION_TOKEN_USED', 'Confirmation token has expired (15-minute TTL).', {}, 'no_retry');
    }
    if (entry.documentId !== documentId) {
        throw new OrbitalError('CONFLICT_CONFIRMATION_TOKEN_USED', 'Confirmation token was issued for a different document.', {}, 'no_retry');
    }
    // Mark as used — single-use
    entry.used = true;
}
/** Exported for tests to clear state between test cases. */
export function _clearTokenStore() {
    _tokenStore.clear();
}
// ---------------------------------------------------------------------------
// Content hash helper
// ---------------------------------------------------------------------------
export function computeContentHash(content) {
    const canonical = JSON.stringify(content, Object.keys(content).sort());
    return createHash('sha256').update(canonical).digest('hex');
}
// ---------------------------------------------------------------------------
// Allowed transition table
// ---------------------------------------------------------------------------
const ALLOWED_TRANSITIONS = {
    drafting: new Set(['locked', 'abandoned']),
    locked: new Set(['revised', 'abandoned']),
    revised: new Set(['revised', 'abandoned']),
    abandoned: new Set(),
};
//# sourceMappingURL=lifecycle.js.map