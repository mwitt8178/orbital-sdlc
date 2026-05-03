/**
 * ac-check-evidence.ts — Drizzle schema for the per-AC verifier evidence table.
 *
 * Per Round 5C spec and architecture.md:
 *   audit.ac_check_evidence — one row per AC checked by the verifier.
 *
 * The verifier writes one row per AC during a verification run. The UAT UI
 * reads the most recent evidence for an AC via `uat.ac.evidence` (joining on
 * ac_id, ORDER BY created_at DESC, LIMIT 1).
 *
 * Logical FKs (no physical FK, per DSQL hard-no list):
 *   - verification_id → verifications.verification_id (TRD-09 §4.4)
 *   - ac_id           → story_acceptance_criteria.ac_id (TRD-02 §4.1)
 *
 * Mutability:
 *   - INSERT-only at the application layer; rows are immutable evidence.
 *   - No DB-level append-only trigger (the audit.events table has one; this
 *     is a softer constraint for evidence rows because re-verification
 *     intentionally writes new rows rather than mutating old ones).
 */
import { pgSchema, uuid, text, integer, jsonb, timestamp, index, } from 'drizzle-orm/pg-core';
// Re-use the existing audit schema (created by migration 0001).
const audit = pgSchema('audit');
// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------
export const AC_EVIDENCE_RESULT = ['pass', 'fail', 'ambiguous'];
export const AC_EVIDENCE_KIND = [
    'test_run',
    'static_analysis',
    'llm_inspection',
    'manual_required',
    'ci_run',
];
export const CI_CONCLUSION = [
    'success',
    'failure',
    'cancelled',
    'skipped',
    'timed_out',
    'neutral',
    'action_required',
];
// ---------------------------------------------------------------------------
// audit.ac_check_evidence
// ---------------------------------------------------------------------------
export const acCheckEvidence = audit.table('ac_check_evidence', {
    evidenceId: uuid('evidence_id').primaryKey(),
    verificationId: uuid('verification_id').notNull(),
    acId: uuid('ac_id').notNull(),
    result: text('result', { enum: AC_EVIDENCE_RESULT }).notNull(),
    evidenceKind: text('evidence_kind', { enum: AC_EVIDENCE_KIND }).notNull(),
    /** The exact command line that was spawned (e.g. "npx vitest run path/to/test.ts"). */
    testCommand: text('test_command'),
    /** Captured stdout+stderr of the test process. May be large. */
    testOutput: text('test_output'),
    testExitCode: integer('test_exit_code'),
    /** When evidence_kind='llm_inspection', the model's reasoning JSON. */
    llmReasoning: text('llm_reasoning'),
    /** When evidence_kind='ci_run', the GitHub Actions run URL. */
    ciRunUrl: text('ci_run_url'),
    /** When evidence_kind='ci_run', the check name (e.g. "CI / vitest"). */
    ciCheckName: text('ci_check_name'),
    /** When evidence_kind='ci_run', the GitHub conclusion string. */
    ciConclusion: text('ci_conclusion', { enum: CI_CONCLUSION }),
    /** Files that the verifier examined while reaching the verdict. */
    filesInspected: jsonb('files_inspected').$type().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
}, (t) => ({
    byAc: index('ac_check_evidence_ac_idx').on(t.acId, t.createdAt),
    byVerification: index('ac_check_evidence_verif_idx').on(t.verificationId),
}));
//# sourceMappingURL=ac-check-evidence.js.map