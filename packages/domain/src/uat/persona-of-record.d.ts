/**
 * uat/persona-of-record.ts — PersonaOfRecord resolution.
 *
 * Per TRD-11 v0.2 §8.2 and §7.2.
 *
 * ## Two resolution modes
 *
 * ### 1. Defect-creation carry-forward — DefaultPersonaOfRecord.resolve()
 *
 * Used by the UAT submit path when creating defects for failed ACs.
 * Algorithm (TRD-11 §8.2, four-level precedence):
 *
 * 1. AC-scoped link: persona_of_record_links row with (story_id, ac_id, role='implementation')
 * 2. Story-scoped implementation link: unique (story_id, role='implementation') row
 * 3. Most-recent implementation task: tasks row for story_id with persona_id, ordered
 *    by task UUIDv7 DESC (which encodes creation time).
 * 4. Fallback: sentinel 'persona:unknown', emits PersonaOfRecordUnresolvable audit event.
 *
 * ### 2. Attestation-chain walk — resolvePersonaOfRecord()
 *
 * Resolves the persona that signed the commit that last touched each given file path,
 * by traversing the full cryptographic chain per TRD-11 §7.2 / SAO §5.9:
 *
 *   git blame → commit_hash → CommitSigned event → actor.persona_id
 *             ↓ (if CommitSigned not found)
 *             capability_grants.capability_id → persona_id
 *             ↓ (if capability not found)
 *             tasks.persona_id (assigned persona, the final DB fallback)
 *
 * This function is used by the audit reconciler and retro analysis layer to
 * attribute file-level authorship beyond what the POR links table records.
 * It is NOT used directly by the defect-creation path (that uses mode 1 above).
 *
 * NOTE on CommitSigned: as of the current phase, commit-signing is wired in
 * Phase 6C. If no CommitSigned events are present in the log, the function
 * falls through cleanly to the capability_grants step. Each step logs a
 * structured WARN when it fails, so the audit reconciler can spot gaps.
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { AnthropicDriver } from '../../../orchestrator/src/personas/anthropic-driver.js';
export declare const PERSONA_OF_RECORD_UNKNOWN = "persona:unknown";
export interface PersonaOfRecordResolveParams {
    acId: string;
    storyId: string;
    sessionId: string;
    traceId?: string;
    /**
     * Optional defect description (free text from the UAT submitter).
     * Used by the LLM reasoning step when present.
     */
    defectDescription?: string;
}
export interface PersonaOfRecord {
    /**
     * Resolve the persona-of-record for a given AC + story combination.
     *
     * Returns the persona_id string. If unresolvable, returns the sentinel
     * PERSONA_OF_RECORD_UNKNOWN and emits a PersonaOfRecordUnresolvable event.
     */
    resolve(params: PersonaOfRecordResolveParams): Promise<string>;
}
export declare class DefaultPersonaOfRecord implements PersonaOfRecord {
    private readonly db;
    private readonly eventStore;
    /**
     * Optional AnthropicDriver. When present and ANTHROPIC_API_KEY is set,
     * the resolver runs an LLM reasoning step at step 3.5 (between the most-
     * recent task lookup and the sentinel fallback) to attribute the defect
     * to the most likely persona based on commit history + defect description.
     */
    private readonly driver;
    constructor(db: DB, eventStore: EventStore, 
    /**
     * Optional AnthropicDriver. When present and ANTHROPIC_API_KEY is set,
     * the resolver runs an LLM reasoning step at step 3.5 (between the most-
     * recent task lookup and the sentinel fallback) to attribute the defect
     * to the most likely persona based on commit history + defect description.
     */
    driver?: AnthropicDriver | null);
    resolve(params: PersonaOfRecordResolveParams): Promise<string>;
    private _reasonViaDriver;
}
export declare function createPersonaOfRecord(db: DB, eventStore: EventStore, driver?: AnthropicDriver | null): PersonaOfRecord;
/**
 * Result of one file-path resolution in the attestation chain.
 * Each field documents which step resolved the persona (for audit logging).
 */
export interface AttestationChainResult {
    /** The file path that was resolved. */
    filePath: string;
    /** The resolved persona id, or PERSONA_OF_RECORD_UNKNOWN if unresolvable. */
    personaId: string;
    /**
     * Which step resolved the persona:
     * - 'commit_signed_event': git blame → CommitSigned event actor
     * - 'capability_grant': capability_id on the task → capability_grants.persona_id
     * - 'task_persona': tasks.persona_id (assigned persona; no commit attestation)
     * - 'unknown': sentinel; all steps failed
     */
    resolvedBy: 'commit_signed_event' | 'capability_grant' | 'task_persona' | 'unknown';
    /** The commit hash that git blame identified, if any. */
    commitHash?: string;
    /** The event_id of the CommitSigned event, if found. */
    commitSignedEventId?: string;
    /** The capability_id used to locate the persona, if found. */
    capabilityId?: string;
}
/**
 * Resolve the persona-of-record for a task by walking the cryptographic
 * attestation chain from git-blame all the way up to the DB fallback.
 *
 * Algorithm (TRD-11 §7.2):
 *
 * Step 1 — git blame on each filePath in the task's worktree.
 *   Uses the worktree path from the `worktrees` table for the task. If the
 *   worktree no longer exists (task done + cleaned up), skips to step 2
 *   using the task's `currentCapabilityId` directly.
 *
 * Step 2 — CommitSigned event lookup.
 *   For each commit hash from step 1, query `audit.events` for
 *   event_type = 'CommitSigned' AND payload->>'commit_hash' = hash.
 *   If found, extract actor.persona_id (when actor.type = 'persona').
 *   Returns on first match.
 *   NOTE: If Phase 6C commit-signing is not yet active, no CommitSigned
 *   events exist; this step falls through cleanly.
 *
 * Step 3 — capability_grants fallback.
 *   If no CommitSigned event found, look up the task's `currentCapabilityId`
 *   in `capability_grants`. The grant's `persona_id` is the persona that held
 *   the capability at commit time.
 *
 * Step 4 — tasks.persona_id (final fallback).
 *   The assigned persona from the tasks row. Always present; used when steps
 *   1–3 all yield nothing.
 *
 * @param taskId     — UUID of the task whose authorship is being resolved.
 * @param filePaths  — File paths (relative to the worktree root) to trace.
 *                     The function resolves each independently and returns the
 *                     persona from the *first* file that yields a result.
 * @param db         — Drizzle DB handle.
 * @param traceId    — Optional trace id for structured logging correlation.
 * @returns          — Array with one result per filePath.
 */
export declare function resolvePersonaOfRecord(taskId: string, filePaths: string[], db: DB, traceId?: string): Promise<AttestationChainResult[]>;
//# sourceMappingURL=persona-of-record.d.ts.map