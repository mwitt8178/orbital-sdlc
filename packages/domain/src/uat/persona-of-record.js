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
import { execFileSync } from 'node:child_process';
import { eq, and, desc } from 'drizzle-orm';
import { sql as dSQL } from 'drizzle-orm';
import { personaOfRecordLinks } from '@orbital/db';
import { tasks, worktrees } from '@orbital/db';
import { capabilityGrants } from '@orbital/db';
import { events } from '@orbital/db';
import { logger } from '../logger.js';
import { uuidv7 } from 'uuidv7';
import { AnthropicDriverNoKeyError } from '../../../orchestrator/src/personas/anthropic-driver.js';
import { buildPersonaOfRecordSystemPrompt, buildPersonaOfRecordUserPrompt, PersonaOfRecordResponseSchema, } from '../../../orchestrator/src/personas/prompts/persona-of-record.js';
/**
 * Confidence threshold for accepting an LLM-suggested persona-of-record.
 * Below this we prefer the deterministic tasks.persona_id fallback.
 */
const PERSONA_OF_RECORD_CONFIDENCE_THRESHOLD = 60;
// Sentinel used when no persona can be resolved (TRD-11 §8.2 step 4).
export const PERSONA_OF_RECORD_UNKNOWN = 'persona:unknown';
export class DefaultPersonaOfRecord {
    db;
    eventStore;
    driver;
    constructor(db, eventStore, 
    /**
     * Optional AnthropicDriver. When present and ANTHROPIC_API_KEY is set,
     * the resolver runs an LLM reasoning step at step 3.5 (between the most-
     * recent task lookup and the sentinel fallback) to attribute the defect
     * to the most likely persona based on commit history + defect description.
     */
    driver = null) {
        this.db = db;
        this.eventStore = eventStore;
        this.driver = driver;
    }
    async resolve(params) {
        const { acId, storyId, sessionId, defectDescription } = params;
        const traceId = params.traceId ?? uuidv7();
        // -----------------------------------------------------------------------
        // Step 1: AC-scoped implementation link
        // -----------------------------------------------------------------------
        const acScopedLinks = await this.db
            .select()
            .from(personaOfRecordLinks)
            .where(and(eq(personaOfRecordLinks.storyId, storyId), eq(personaOfRecordLinks.acId, acId), eq(personaOfRecordLinks.role, 'implementation')))
            .limit(1);
        if (acScopedLinks.length > 0 && acScopedLinks[0]) {
            logger.debug({ acId, storyId, personaId: acScopedLinks[0].personaId }, 'PersonaOfRecord: resolved via AC-scoped link (step 1)');
            return acScopedLinks[0].personaId;
        }
        // -----------------------------------------------------------------------
        // Step 2: Story-scoped implementation link (exactly one row)
        // -----------------------------------------------------------------------
        const storyScopedLinks = await this.db
            .select()
            .from(personaOfRecordLinks)
            .where(and(eq(personaOfRecordLinks.storyId, storyId), eq(personaOfRecordLinks.role, 'implementation')));
        if (storyScopedLinks.length === 1 && storyScopedLinks[0]) {
            logger.debug({ storyId, personaId: storyScopedLinks[0].personaId }, 'PersonaOfRecord: resolved via story-scoped implementation link (step 2)');
            return storyScopedLinks[0].personaId;
        }
        // -----------------------------------------------------------------------
        // Step 3: Most-recent implementation task for this story
        //
        // NOTE (v1 simplification): We read tasks.persona_id directly. The full
        // attestation chain (commit hash → capability_grants bundle → persona_id)
        // is deferred to Phase 6C (orbital verify CLI, TRD-06 §5.9 commit
        // attestation). Deferred: capability_grants join on commit attestation.
        // -----------------------------------------------------------------------
        const taskRows = await this.db
            .select({ taskId: tasks.taskId, personaId: tasks.personaId })
            .from(tasks)
            .where(eq(tasks.storyId, storyId))
            .orderBy(desc(tasks.taskId)) // UUIDv7 → time-ordered DESC = most recent first
            .limit(10);
        if (taskRows.length > 0 && taskRows[0]) {
            const tasksFallbackPersonaId = taskRows[0].personaId;
            // Step 3.5: optional LLM reasoning. When the driver is available AND a
            // defect description was supplied, ask the LLM to consider the commit
            // history and propose a persona-of-record. Only used when the LLM's
            // confidence_score >= threshold; otherwise we keep tasks.persona_id.
            if (this.driver && defectDescription) {
                const reasoned = await this._reasonViaDriver({
                    acId,
                    storyId,
                    sessionId,
                    traceId,
                    defectDescription,
                    taskId: taskRows[0].taskId,
                    tasksFallbackPersonaId,
                }).catch((err) => {
                    if (err instanceof AnthropicDriverNoKeyError) {
                        logger.debug({ acId, storyId }, 'PersonaOfRecord: ANTHROPIC_API_KEY unset; using tasks.persona_id');
                    }
                    else {
                        logger.warn({ err, acId, storyId }, 'PersonaOfRecord: driver reasoning failed; using tasks.persona_id');
                    }
                    return null;
                });
                if (reasoned !== null) {
                    logger.info({
                        storyId,
                        taskId: taskRows[0].taskId,
                        suggestedPersona: reasoned.persona_id,
                        confidence: reasoned.confidence_score,
                        fallback: tasksFallbackPersonaId,
                    }, 'PersonaOfRecord: LLM-reasoned persona accepted (step 3.5)');
                    return reasoned.persona_id;
                }
            }
            logger.debug({ storyId, taskId: taskRows[0].taskId, personaId: tasksFallbackPersonaId }, 'PersonaOfRecord: resolved via most-recent task persona_id (step 3)');
            return tasksFallbackPersonaId;
        }
        // -----------------------------------------------------------------------
        // Step 4: Fallback — sentinel; emit audit warning
        // -----------------------------------------------------------------------
        logger.warn({ acId, storyId, sessionId }, 'PersonaOfRecord: unresolvable — falling back to sentinel persona:unknown');
        await this.eventStore.append({
            aggregate_id: sessionId,
            aggregate_type: 'uat_session',
            event_type: 'PersonaOfRecordUnresolvable',
            payload: {
                uat_session_id: sessionId,
                story_id: storyId,
                ac_id: acId,
                reason: 'No persona_of_record_links and no tasks found for story',
            },
            actor: { type: 'system', component: 'orchestrator' },
            trace_id: traceId,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
        return PERSONA_OF_RECORD_UNKNOWN;
    }
    // -------------------------------------------------------------------------
    // LLM reasoning step: returns null when (a) driver throws, (b) confidence
    // below threshold, or (c) suggested persona is not in the candidate list.
    // -------------------------------------------------------------------------
    async _reasonViaDriver(params) {
        if (!this.driver) {
            throw new AnthropicDriverNoKeyError();
        }
        // Pull a small recent commit log + file paths from the task's worktree.
        const filePaths = [];
        const recentCommits = [];
        const taskRow = await this.db
            .select({
            currentWorktreeId: tasks.currentWorktreeId,
            declaredWritePaths: tasks.declaredWritePaths,
        })
            .from(tasks)
            .where(eq(tasks.taskId, params.taskId))
            .limit(1);
        if (taskRow[0]?.declaredWritePaths) {
            const paths = taskRow[0].declaredWritePaths;
            for (const p of paths.slice(0, 10))
                filePaths.push(p);
        }
        if (taskRow[0]?.currentWorktreeId) {
            const wt = await this.db
                .select({ path: worktrees.path })
                .from(worktrees)
                .where(eq(worktrees.worktreeId, taskRow[0].currentWorktreeId))
                .limit(1);
            const wtPath = wt[0]?.path;
            if (wtPath && filePaths.length > 0) {
                try {
                    const log = execFileSync('git', ['log', '-5', '--format=%H%x09%an%x09%s', '--', ...filePaths], { cwd: wtPath, timeout: 3000, encoding: 'utf8' });
                    for (const line of log.trim().split('\n').filter(Boolean)) {
                        const [sha, author, message] = line.split('\t');
                        if (sha && author && message) {
                            recentCommits.push({ sha, author, message, files: filePaths });
                        }
                    }
                }
                catch {
                    // git log failed — skip this commit-log enrichment but continue
                }
            }
        }
        const candidatePersonaSlugs = [
            'pm',
            'sr-dev',
            'jr-dev',
            'principal-dev',
            'qa',
            'em',
            'architect',
            'security',
            'scrum-master',
        ];
        const ctx = {
            acId: params.acId,
            storyId: params.storyId,
            defectDescription: params.defectDescription,
            filePaths,
            recentCommits,
            candidatePersonaSlugs,
            tasksFallbackPersonaId: params.tasksFallbackPersonaId,
        };
        const systemPrompt = buildPersonaOfRecordSystemPrompt();
        const userPrompt = buildPersonaOfRecordUserPrompt(ctx);
        const result = await this.driver.invoke({
            persona: 'persona-of-record',
            riskClass: 'low',
            sessionId: params.sessionId,
            systemPrompt,
            userPrompt,
            responseSchema: PersonaOfRecordResponseSchema,
            maxTokens: 512,
            traceId: params.traceId,
        });
        const r = result.result;
        // Confidence gate: below threshold, defer to tasks.persona_id.
        if (r.confidence_score < PERSONA_OF_RECORD_CONFIDENCE_THRESHOLD) {
            logger.debug({
                acId: params.acId,
                confidence: r.confidence_score,
                threshold: PERSONA_OF_RECORD_CONFIDENCE_THRESHOLD,
            }, 'PersonaOfRecord: LLM confidence below threshold, deferring');
            return null;
        }
        // Sanity-check the suggested persona is in the candidate list.
        if (!candidatePersonaSlugs.includes(r.persona_id)) {
            logger.warn({ suggested: r.persona_id, candidates: candidatePersonaSlugs }, 'PersonaOfRecord: LLM suggested an unknown persona; deferring to fallback');
            return null;
        }
        return { persona_id: r.persona_id, confidence_score: r.confidence_score };
    }
}
export function createPersonaOfRecord(db, eventStore, driver = null) {
    return new DefaultPersonaOfRecord(db, eventStore, driver);
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
export async function resolvePersonaOfRecord(taskId, filePaths, db, traceId) {
    const tid = traceId ?? uuidv7();
    if (filePaths.length === 0) {
        return [];
    }
    // -------------------------------------------------------------------------
    // Pre-load task row (needed by steps 3 and 4)
    // -------------------------------------------------------------------------
    const taskRows = await db
        .select({
        taskId: tasks.taskId,
        personaId: tasks.personaId,
        currentCapabilityId: tasks.currentCapabilityId,
        currentWorktreeId: tasks.currentWorktreeId,
    })
        .from(tasks)
        .where(eq(tasks.taskId, taskId))
        .limit(1);
    const taskRow = taskRows[0];
    if (!taskRow) {
        logger.warn({ taskId, traceId: tid }, 'resolvePersonaOfRecord: task not found');
        return filePaths.map((fp) => ({
            filePath: fp,
            personaId: PERSONA_OF_RECORD_UNKNOWN,
            resolvedBy: 'unknown',
        }));
    }
    // -------------------------------------------------------------------------
    // Resolve worktree path (for git blame in step 1)
    // -------------------------------------------------------------------------
    let worktreePath = null;
    if (taskRow.currentWorktreeId !== null) {
        const wtRows = await db
            .select({ path: worktrees.path })
            .from(worktrees)
            .where(eq(worktrees.worktreeId, taskRow.currentWorktreeId))
            .limit(1);
        const wt = wtRows[0];
        worktreePath = wt ? wt.path : null;
    }
    // -------------------------------------------------------------------------
    // Resolve each file path
    // -------------------------------------------------------------------------
    const results = [];
    for (const filePath of filePaths) {
        const result = await resolveOneFilePath({
            filePath,
            taskId,
            personaId: taskRow.personaId,
            currentCapabilityId: taskRow.currentCapabilityId ?? null,
            worktreePath,
            db,
            traceId: tid,
        });
        results.push(result);
    }
    return results;
}
// ---------------------------------------------------------------------------
// Internal: resolve one file path through the full chain
// ---------------------------------------------------------------------------
async function resolveOneFilePath(params) {
    const { filePath, taskId, personaId, currentCapabilityId, worktreePath, db, traceId } = params;
    // -------------------------------------------------------------------------
    // Step 1: git blame → commit hash
    // -------------------------------------------------------------------------
    let commitHash = null;
    if (worktreePath !== null) {
        commitHash = gitLastCommit(filePath, worktreePath, taskId, traceId);
    }
    // -------------------------------------------------------------------------
    // Step 2: CommitSigned event lookup
    // -------------------------------------------------------------------------
    if (commitHash !== null) {
        const commitSignedResult = await lookupCommitSignedEvent(commitHash, db, traceId);
        if (commitSignedResult !== null) {
            return {
                filePath,
                personaId: commitSignedResult.personaId,
                resolvedBy: 'commit_signed_event',
                commitHash,
                commitSignedEventId: commitSignedResult.eventId,
            };
        }
        logger.debug({ taskId, filePath, commitHash, traceId }, 'resolvePersonaOfRecord: no CommitSigned event for commit — falling through to capability');
    }
    // -------------------------------------------------------------------------
    // Step 3: capability_grants fallback
    // -------------------------------------------------------------------------
    if (currentCapabilityId !== null) {
        const capResult = await lookupCapabilityGrant(currentCapabilityId, db, traceId);
        if (capResult !== null) {
            return {
                filePath,
                personaId: capResult.personaId,
                resolvedBy: 'capability_grant',
                commitHash: commitHash ?? undefined,
                capabilityId: currentCapabilityId,
            };
        }
        logger.debug({ taskId, filePath, currentCapabilityId, traceId }, 'resolvePersonaOfRecord: capability_grant not found — falling through to task persona');
    }
    // -------------------------------------------------------------------------
    // Step 4: tasks.persona_id (always present; final fallback)
    // -------------------------------------------------------------------------
    if (personaId !== null && personaId !== undefined) {
        logger.debug({ taskId, filePath, personaId, traceId }, 'resolvePersonaOfRecord: resolved via task persona_id (step 4)');
        return {
            filePath,
            personaId,
            resolvedBy: 'task_persona',
            commitHash: commitHash ?? undefined,
        };
    }
    // Should never reach here given tasks.persona_id is NOT NULL, but be defensive.
    logger.warn({ taskId, filePath, traceId }, 'resolvePersonaOfRecord: all steps failed — sentinel');
    return {
        filePath,
        personaId: PERSONA_OF_RECORD_UNKNOWN,
        resolvedBy: 'unknown',
        commitHash: commitHash ?? undefined,
    };
}
// ---------------------------------------------------------------------------
// Step 1 helper: git blame → last commit hash for a file
// ---------------------------------------------------------------------------
/**
 * Run `git log -1 --format=%H -- <filePath>` in the worktree directory.
 * Returns the commit hash string, or null on failure (file not tracked, error,
 * git not available, etc.).
 */
function gitLastCommit(filePath, worktreePath, taskId, traceId) {
    try {
        const output = execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], {
            cwd: worktreePath,
            timeout: 5000,
            encoding: 'utf8',
        }).trim();
        if (!output || output.length !== 40) {
            // Empty output means the file has no commits in this worktree (untracked or new).
            logger.debug({ taskId, filePath, worktreePath, traceId }, 'resolvePersonaOfRecord: git log returned no commit for file');
            return null;
        }
        return output;
    }
    catch (err) {
        logger.warn({ err, taskId, filePath, worktreePath, traceId }, 'resolvePersonaOfRecord: git log failed for file — skipping step 1');
        return null;
    }
}
// ---------------------------------------------------------------------------
// Step 2 helper: CommitSigned event lookup
// ---------------------------------------------------------------------------
/**
 * Query the audit events table for a CommitSigned event whose payload
 * contains commit_hash = hash. Returns { personaId, eventId } or null.
 *
 * The actor discriminated union is inspected: we only use it when
 * actor.type = 'persona' (a human or AI persona signed the commit).
 */
async function lookupCommitSignedEvent(commitHash, db, traceId) {
    try {
        const rows = await db
            .select({
            eventId: events.eventId,
            actor: events.actor,
        })
            .from(events)
            .where(and(eq(events.eventType, 'CommitSigned'), dSQL `${events.payload}->>'commit_hash' = ${commitHash}`))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        // Extract persona_id from the actor discriminated union.
        const actor = row.actor;
        if (actor['type'] === 'persona' && typeof actor['persona_id'] === 'string') {
            return { personaId: actor['persona_id'], eventId: row.eventId };
        }
        // Actor present but not a persona — log and fall through.
        logger.debug({ commitHash, actorType: actor['type'], traceId }, 'resolvePersonaOfRecord: CommitSigned event found but actor is not persona type');
        return null;
    }
    catch (err) {
        logger.warn({ err, commitHash, traceId }, 'resolvePersonaOfRecord: error querying CommitSigned event — skipping step 2');
        return null;
    }
}
// ---------------------------------------------------------------------------
// Step 3 helper: capability_grants lookup
// ---------------------------------------------------------------------------
/**
 * Look up the persona_id from capability_grants by capability_id.
 */
async function lookupCapabilityGrant(capabilityId, db, traceId) {
    try {
        const rows = await db
            .select({ personaId: capabilityGrants.persona_id })
            .from(capabilityGrants)
            .where(eq(capabilityGrants.capability_id, capabilityId))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        return { personaId: row.personaId };
    }
    catch (err) {
        logger.warn({ err, capabilityId, traceId }, 'resolvePersonaOfRecord: error querying capability_grants — skipping step 3');
        return null;
    }
}
//# sourceMappingURL=persona-of-record.js.map