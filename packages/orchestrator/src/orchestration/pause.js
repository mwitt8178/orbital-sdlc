/**
 * pause.ts — PauseController.
 *
 * Per TRD-04 v0.2 §12.
 *
 * Pause flow:
 *   1. Mark all active workers in the sprint as status='terminating' so the
 *      richer task.complete / task.fail tools (registry-bootstrap.ts) refuse
 *      new mutations from these workers, returning CONFLICT_INVALID_STATE_TRANSITION.
 *   2. Send SIGTERM to each worker's OS process (if pid is recorded). After a
 *      5-second grace period send SIGKILL to any still-alive processes.
 *   3. Wait up to DRAIN_GRACE_MS for in-flight tool calls / heartbeats to settle.
 *   4. Revoke every active capability for the sprint via CapabilityAuthority.revoke.
 *   5. Set worker_pool_state.paused=true, bump scheduler_epoch.
 *   6. Emit OrchestrationPauseDrained.
 *
 * Resume flow:
 *   1. For every task in state='ready' for the sprint, re-issue a capability
 *      via CapabilityAuthority.issue using the persona's defaultCapabilityProfile.
 *   2. Clear paused flag, bump scheduler_epoch.
 *   3. Emit OrchestrationResumeApplied.
 *
 * SIGTERM semantics (TRD-04 §12 clarification):
 *   - Only workers in 'active' or 'draining' status are signaled.
 *   - Workers in 'terminated' or 'idle' status are never signaled.
 *   - After SIGTERM, a 5-second grace period is given. Any process still alive
 *     at that point receives SIGKILL.
 *   - All signal attempts (SIGTERM, SIGKILL, pid-not-found) are logged.
 *   - Capability revocation is the hard security boundary; SIGTERM/SIGKILL is
 *     a best-effort cleanup to prevent workers from consuming CPU after revocation.
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, sql as dSQL } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { resolvePersona } from './persona-lookup.js';
import { tasks, workerPoolState } from '../db/schema/orchestration.js';
import { agentWorkers } from '../db/schema/worker-tables.js';
import { logger } from '../config/logger.js';
import { DRAIN_GRACE_MS } from './types.js';
/** Grace period (ms) between SIGTERM and SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
export class PauseController {
    db;
    eventStore;
    authority;
    personaLoader;
    installId;
    drainGraceMs;
    pollIntervalMs;
    nowFn;
    sigkillGraceMs;
    killFn;
    constructor(db, eventStore, authority, personaLoader, installId, options = {}) {
        this.db = db;
        this.eventStore = eventStore;
        this.authority = authority;
        this.personaLoader = personaLoader;
        this.installId = installId;
        this.drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? 250;
        this.nowFn = options.nowFn ?? (() => new Date());
        this.sigkillGraceMs = options.sigkillGraceMs ?? SIGKILL_GRACE_MS;
        this.killFn = options.killFn ?? ((pid, signal) => process.kill(pid, signal));
    }
    // -------------------------------------------------------------------------
    // pause
    // -------------------------------------------------------------------------
    async pause(sprintId, traceId) {
        const start = this.nowFn().getTime();
        // Step 1: find active workers for this sprint via tasks.sprintId join.
        const activeWorkers = await this.findActiveSprintWorkers(sprintId);
        if (activeWorkers.length === 0) {
            // Nothing to drain. Just flip the flag and emit.
            await this.flipPaused(true, sprintId);
            await this.emitDrained(sprintId, [], traceId);
            return { drainedWorkerIds: [], revokedCapabilityIds: [] };
        }
        // Step 2: mark workers as terminating.
        for (const w of activeWorkers) {
            await this.db
                .update(agentWorkers)
                .set({ status: 'terminating' })
                .where(eq(agentWorkers.workerId, w.workerId));
        }
        // Step 2b: signal child processes — SIGTERM now, SIGKILL after grace.
        // This runs concurrently with the drain poll below; signalWorkers awaits
        // the SIGKILL grace internally.
        void this.signalWorkers(activeWorkers);
        // Step 3: wait up to drainGraceMs for workers to wind down (i.e. status
        // 'terminated' or task moves to a terminal state). We poll because we don't
        // own the child processes here.
        const deadline = start + this.drainGraceMs;
        while (this.nowFn().getTime() < deadline) {
            const stillActive = await this.findActiveSprintWorkers(sprintId);
            const stillTerminating = stillActive.filter((w) => w.status !== 'terminated');
            if (stillTerminating.length === 0)
                break;
            await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        }
        // Step 4: revoke capabilities for the sprint's still-active workers.
        const revokedCapabilityIds = [];
        const drainedWorkerIds = [];
        const finalWorkers = await this.findActiveSprintWorkers(sprintId);
        for (const w of finalWorkers) {
            try {
                await this.authority.revoke(w.capabilityId, {
                    reason: 'sprint_pause',
                    reason_detail: `sprint ${sprintId} paused`,
                    actor: SYSTEM_ACTOR,
                    trace_id: traceId,
                });
                revokedCapabilityIds.push(w.capabilityId);
            }
            catch (err) {
                // Idempotency: revoke may have already occurred.
                logger.warn({ err, workerId: w.workerId, capabilityId: w.capabilityId }, 'PauseController: revoke failed (likely already revoked); continuing');
            }
            // Force-mark workers terminated since their capabilities are dead.
            await this.db
                .update(agentWorkers)
                .set({ status: 'terminated' })
                .where(eq(agentWorkers.workerId, w.workerId));
            drainedWorkerIds.push(w.workerId);
        }
        // Step 5: flip paused flag, bump epoch.
        await this.flipPaused(true, sprintId);
        // Step 6: emit OrchestrationPauseDrained.
        await this.emitDrained(sprintId, drainedWorkerIds, traceId, revokedCapabilityIds);
        logger.info({ sprintId, drained: drainedWorkerIds.length, revoked: revokedCapabilityIds.length }, 'PauseController: paused sprint');
        return { drainedWorkerIds, revokedCapabilityIds };
    }
    // -------------------------------------------------------------------------
    // resume
    // -------------------------------------------------------------------------
    async resume(sprintId, traceId) {
        // Find ready tasks for the sprint.
        const readyTasks = await this.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.sprintId, sprintId), eq(tasks.state, 'ready')));
        let reissuedCapabilityCount = 0;
        const resumedTaskIds = [];
        for (const t of readyTasks) {
            try {
                const persona = await resolvePersona(this.db, this.personaLoader, t.personaId);
                const profile = persona.defaultCapabilityProfile;
                const sessionId = uuidv7();
                await this.authority.issue({
                    install_id: this.installId,
                    persona_id: t.personaId,
                    task_id: t.taskId,
                    sprint_id: sprintId,
                    session_id: sessionId,
                    scopes: {
                        files_read: profile.filesRead,
                        files_write: profile.filesWrite,
                        board_read: profile.boardRead,
                        board_mutate: profile.boardMutate,
                        channel_read: profile.channelRead,
                        channel_post: profile.channelPost,
                        secrets: profile.secrets,
                        network_egress: profile.networkEgress,
                        spawn_subagent: profile.spawnSubagent,
                        git_commit: profile.gitCommit
                            ? [{ branch: profile.gitCommit.branchPattern, paths: [profile.gitCommit.pathGlob] }]
                            : [],
                        ceremony_role: profile.ceremonyRole === 'none'
                            ? []
                            : [profile.ceremonyRole],
                    },
                    ttl_ms: 30 * 60 * 1000,
                    justification: `Sprint ${sprintId} resumed: re-issuing capability for ready task`,
                    actor: SYSTEM_ACTOR,
                    trace_id: traceId,
                });
                reissuedCapabilityCount++;
                resumedTaskIds.push(t.taskId);
            }
            catch (err) {
                logger.warn({ err, taskId: t.taskId }, 'PauseController.resume: failed to re-issue capability for task; continuing');
            }
        }
        await this.flipPaused(false, sprintId);
        await this.emitResumeApplied(sprintId, resumedTaskIds, reissuedCapabilityCount, traceId);
        logger.info({ sprintId, reissued: reissuedCapabilityCount, resumedTasks: resumedTaskIds.length }, 'PauseController: resumed sprint');
        return { reissuedCapabilityCount, resumedTaskIds };
    }
    // -------------------------------------------------------------------------
    // pauseDueToCostCeiling — [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
    // -------------------------------------------------------------------------
    /**
     * Pause a scope because its budget ceiling was breached.
     *
     * For sprint scope: delegates to pause(sprintId, traceId).
     * For project/install scope: flips the global pool paused flag (all sprints
     * will be blocked at tick() time) and emits OrchestrationPauseDrained.
     */
    async pauseDueToCostCeiling(scope, scopeId, reason) {
        const traceId = uuidv7();
        logger.warn({ scope, scopeId, reason }, 'PauseController.pauseDueToCostCeiling: pausing scope due to budget ceiling');
        if (scope === 'sprint') {
            return this.pause(scopeId, traceId);
        }
        // For project/install: flip pool paused and emit event.
        await this.flipPaused(true, scopeId);
        await this.emitDrained(scopeId, [], traceId);
        return { drainedWorkerIds: [], revokedCapabilityIds: [] };
    }
    // -------------------------------------------------------------------------
    // isPaused
    // -------------------------------------------------------------------------
    async isPaused() {
        const rows = await this.db.select().from(workerPoolState).limit(1);
        return rows[0]?.paused === true;
    }
    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------
    async findActiveSprintWorkers(sprintId) {
        // join via tasks: agent_workers.task_id = tasks.task_id and tasks.sprint_id = sprintId.
        // We do this with a raw select to avoid Drizzle relation-config requirements.
        const rows = await this.db.execute(dSQL `
      SELECT aw.worker_id, aw.task_id, aw.capability_id, aw.status, aw.pid
      FROM agent_workers aw
      LEFT JOIN tasks t ON t.task_id = aw.task_id
      WHERE t.sprint_id = ${sprintId}
        AND aw.status NOT IN ('terminated')
    `);
        // postgres.js returns an array-like object with rows.
        const result = [];
        for (const r of rows) {
            result.push({
                workerId: r.worker_id,
                taskId: r.task_id,
                capabilityId: r.capability_id,
                status: r.status,
                pid: r.pid,
            });
        }
        return result;
    }
    /**
     * Send SIGTERM to each worker process (only active/draining status).
     * After sigkillGraceMs, send SIGKILL to any still-alive processes.
     */
    async signalWorkers(workers) {
        const signalableStatuses = new Set(['active', 'draining', 'terminating']);
        const pidsToKill = [];
        for (const w of workers) {
            if (!signalableStatuses.has(w.status)) {
                logger.debug({ workerId: w.workerId, status: w.status }, 'PauseController.signalWorkers: skipping worker in non-signalable status');
                continue;
            }
            if (w.pid == null) {
                logger.warn({ workerId: w.workerId }, 'PauseController.signalWorkers: no pid recorded for worker; cannot SIGTERM');
                continue;
            }
            try {
                this.killFn(w.pid, 'SIGTERM');
                logger.info({ workerId: w.workerId, pid: w.pid }, 'PauseController.signalWorkers: SIGTERM sent');
                pidsToKill.push(w.pid);
            }
            catch (err) {
                // ESRCH means the process already exited — not an error.
                const code = err.code;
                if (code === 'ESRCH') {
                    logger.debug({ workerId: w.workerId, pid: w.pid }, 'PauseController.signalWorkers: process already exited before SIGTERM');
                }
                else {
                    logger.warn({ err, workerId: w.workerId, pid: w.pid }, 'PauseController.signalWorkers: SIGTERM failed');
                }
            }
        }
        if (pidsToKill.length === 0 || this.sigkillGraceMs <= 0)
            return;
        // Wait for SIGKILL grace period, then forcibly kill any survivors.
        await new Promise((r) => setTimeout(r, this.sigkillGraceMs));
        for (const pid of pidsToKill) {
            try {
                // process.kill(pid, 0) throws if the process is gone — signals otherwise.
                process.kill(pid, 0);
                // Process is still alive; send SIGKILL.
                this.killFn(pid, 'SIGKILL');
                logger.warn({ pid }, 'PauseController.signalWorkers: process survived SIGTERM grace; SIGKILL sent');
            }
            catch (err) {
                const code = err.code;
                if (code === 'ESRCH') {
                    logger.debug({ pid }, 'PauseController.signalWorkers: process exited cleanly after SIGTERM');
                }
                else {
                    logger.warn({ err, pid }, 'PauseController.signalWorkers: SIGKILL check failed');
                }
            }
        }
    }
    async flipPaused(paused, sprintId) {
        const rows = await this.db.select().from(workerPoolState).limit(1);
        const current = rows[0];
        if (!current) {
            // Singleton row should always exist (seeded by migration). If not, insert.
            await this.db.insert(workerPoolState).values({
                id: 1,
                paused,
                pausedReason: paused ? `sprint ${sprintId} paused` : null,
                pausedAt: paused ? new Date() : null,
                schedulerEpoch: 1,
            });
            return;
        }
        await this.db
            .update(workerPoolState)
            .set({
            paused,
            pausedReason: paused ? `sprint ${sprintId} paused` : null,
            pausedAt: paused ? new Date() : null,
            schedulerEpoch: current.schedulerEpoch + 1,
        })
            .where(eq(workerPoolState.id, 1));
    }
    async emitDrained(sprintId, drainedWorkerIds, traceId, revokedCapabilityIds = []) {
        const ev = {
            aggregate_id: sprintId,
            aggregate_type: 'sprint',
            event_type: 'OrchestrationPauseDrained',
            payload: {
                sprint_id: sprintId,
                drained_worker_ids: drainedWorkerIds,
                revoked_capability_ids: revokedCapabilityIds,
            },
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: this.nowFn().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
    }
    async emitResumeApplied(sprintId, resumedTaskIds, reissuedCapabilityCount, traceId) {
        const ev = {
            aggregate_id: sprintId,
            aggregate_type: 'sprint',
            event_type: 'OrchestrationResumeApplied',
            payload: {
                sprint_id: sprintId,
                resumed_task_ids: resumedTaskIds,
                reissued_capability_count: reissuedCapabilityCount,
            },
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: this.nowFn().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createPauseController(db, eventStore, authority, personaLoader, installId, options = {}) {
    return new PauseController(db, eventStore, authority, personaLoader, installId, options);
}
// Re-export OrbitalError for callers (used in tests for assertion).
export { OrbitalError };
//# sourceMappingURL=pause.js.map