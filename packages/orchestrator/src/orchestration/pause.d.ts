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
import { OrbitalError } from '@orbital/types';
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { ICapabilityAuthority } from '../capabilities/authority.js';
import type { PersonaLoader } from '../personas/loader.js';
export interface PauseControllerOptions {
    /** Override drain grace for tests. Default DRAIN_GRACE_MS (60s). */
    drainGraceMs?: number;
    /** Polling interval while waiting for drain. Default 250ms. */
    pollIntervalMs?: number;
    /** Custom now(). */
    nowFn?: () => Date;
    /**
     * Override SIGKILL grace period (ms). Default 5000.
     * Set to 0 in tests to skip waiting.
     */
    sigkillGraceMs?: number;
    /**
     * Inject a custom process-kill function for tests.
     * Signature matches Node's `process.kill(pid, signal)`.
     */
    killFn?: (pid: number, signal: NodeJS.Signals) => void;
}
export interface PauseResult {
    drainedWorkerIds: string[];
    revokedCapabilityIds: string[];
}
export interface ResumeResult {
    reissuedCapabilityCount: number;
    resumedTaskIds: string[];
}
export interface IPauseController {
    pause(sprintId: string, traceId: string): Promise<PauseResult>;
    resume(sprintId: string, traceId: string): Promise<ResumeResult>;
    isPaused(): Promise<boolean>;
    /**
     * Pause a scope (sprint or project) because the cost ceiling was breached.
     * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
     */
    pauseDueToCostCeiling(scope: 'sprint' | 'project' | 'install', scopeId: string, reason: string): Promise<PauseResult>;
}
export declare class PauseController implements IPauseController {
    private readonly db;
    private readonly eventStore;
    private readonly authority;
    private readonly personaLoader;
    private readonly installId;
    private readonly drainGraceMs;
    private readonly pollIntervalMs;
    private readonly nowFn;
    private readonly sigkillGraceMs;
    private readonly killFn;
    constructor(db: DB, eventStore: EventStore, authority: ICapabilityAuthority, personaLoader: PersonaLoader, installId: string, options?: PauseControllerOptions);
    pause(sprintId: string, traceId: string): Promise<PauseResult>;
    resume(sprintId: string, traceId: string): Promise<ResumeResult>;
    /**
     * Pause a scope because its budget ceiling was breached.
     *
     * For sprint scope: delegates to pause(sprintId, traceId).
     * For project/install scope: flips the global pool paused flag (all sprints
     * will be blocked at tick() time) and emits OrchestrationPauseDrained.
     */
    pauseDueToCostCeiling(scope: 'sprint' | 'project' | 'install', scopeId: string, reason: string): Promise<PauseResult>;
    isPaused(): Promise<boolean>;
    private findActiveSprintWorkers;
    /**
     * Send SIGTERM to each worker process (only active/draining status).
     * After sigkillGraceMs, send SIGKILL to any still-alive processes.
     */
    private signalWorkers;
    private flipPaused;
    private emitDrained;
    private emitResumeApplied;
}
export declare function createPauseController(db: DB, eventStore: EventStore, authority: ICapabilityAuthority, personaLoader: PersonaLoader, installId: string, options?: PauseControllerOptions): PauseController;
export { OrbitalError };
//# sourceMappingURL=pause.d.ts.map