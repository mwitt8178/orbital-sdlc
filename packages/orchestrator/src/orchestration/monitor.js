/**
 * monitor.ts — WorkerMonitor.
 *
 * Per TRD-04 v0.2 §13.1.
 *
 * Polls worker_heartbeats every N seconds (default 10s). For each active worker:
 *   - last_heartbeat older than HEARTBEAT_TIMEOUT_MS (90s) → SIGTERM, AgentTimedOut
 *   - SIGTERM not honored within KILL_GRACE_MS (5s) → SIGKILL, AgentFailed
 *
 * The monitor only knows about ChildProcess handles for workers it has been told
 * about via `track(workerId, child)`. Workers not in its registry can still be
 * marked timed-out at the DB level (status=terminated) but cannot be signalled.
 */
import { eq, and, ne } from 'drizzle-orm';
import { agentWorkers } from '../db/schema/worker-tables.js';
import { logger } from '../config/logger.js';
import { HEARTBEAT_TIMEOUT_MS, KILL_GRACE_MS } from './types.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// WorkerMonitor
// ---------------------------------------------------------------------------
export class WorkerMonitor {
    db;
    eventStore;
    children = new Map();
    pollIntervalMs;
    heartbeatTimeoutMs;
    killGraceMs;
    nowFn;
    timer = null;
    constructor(db, eventStore, options = {}) {
        this.db = db;
        this.eventStore = eventStore;
        this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
        this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
        this.nowFn = options.nowFn ?? (() => new Date());
    }
    /** Register a ChildProcess handle so the monitor can signal it. */
    track(workerId, child) {
        this.children.set(workerId, child);
        child.once('exit', () => {
            this.children.delete(workerId);
        });
    }
    /** Forget a worker's handle (e.g. after task.complete revokes capability). */
    untrack(workerId) {
        this.children.delete(workerId);
    }
    /** Start the polling loop. */
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick().catch((err) => {
                logger.error({ err }, 'WorkerMonitor.tick failed');
            });
        }, this.pollIntervalMs);
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
    }
    /** Stop the polling loop. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /**
     * Run a single poll. Returns the workerIds that were timed-out this tick.
     * Public so tests can drive deterministically.
     */
    async tick() {
        const now = this.nowFn();
        const cutoff = new Date(now.getTime() - this.heartbeatTimeoutMs);
        const timedOut = [];
        // Find active workers whose last_heartbeat_at is older than cutoff.
        // status IN ('connecting','active','idle') — anything not already terminating/terminated.
        const candidates = await this.db
            .select()
            .from(agentWorkers)
            .where(and(ne(agentWorkers.status, 'terminated'), ne(agentWorkers.status, 'terminating')));
        for (const w of candidates) {
            const lastHb = w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt) : null;
            const reference = lastHb ?? new Date(w.startedAt);
            if (reference.getTime() > cutoff.getTime())
                continue;
            timedOut.push(w.workerId);
            // Mark as terminating in DB; emit AgentTimedOut.
            await this.db
                .update(agentWorkers)
                .set({ status: 'terminating' })
                .where(eq(agentWorkers.workerId, w.workerId));
            await this.eventStore.append({
                aggregate_id: w.workerId,
                aggregate_type: 'orchestration',
                event_type: 'AgentTimedOut',
                payload: {
                    worker_id: w.workerId,
                    task_id: w.taskId,
                    persona_id: w.personaId,
                    last_heartbeat_at: lastHb ? lastHb.toISOString() : null,
                    heartbeat_timeout_ms: this.heartbeatTimeoutMs,
                    reason: 'heartbeat_stale',
                },
                actor: SYSTEM_ACTOR,
                capability_id: w.capabilityId,
                trace_id: w.workerId,
                occurred_at: now.toISOString(),
                schema_version: 1,
            });
            // SIGTERM → wait killGraceMs → SIGKILL if still alive.
            const child = this.children.get(w.workerId);
            if (child && !child.killed && child.exitCode === null) {
                try {
                    child.kill('SIGTERM');
                }
                catch (err) {
                    logger.warn({ err, workerId: w.workerId }, 'WorkerMonitor: SIGTERM failed; will SIGKILL after grace');
                }
                // After grace, force-kill and emit AgentFailed if not exited.
                const workerId = w.workerId;
                const taskId = w.taskId;
                const personaId = w.personaId;
                const capabilityId = w.capabilityId;
                setTimeout(() => {
                    void (async () => {
                        const stillAlive = child.exitCode === null && !child.killed;
                        if (stillAlive) {
                            try {
                                child.kill('SIGKILL');
                            }
                            catch (err) {
                                logger.warn({ err, workerId }, 'WorkerMonitor: SIGKILL failed');
                            }
                        }
                        // Mark fully terminated.
                        await this.db
                            .update(agentWorkers)
                            .set({ status: 'terminated' })
                            .where(eq(agentWorkers.workerId, workerId));
                        await this.eventStore.append({
                            aggregate_id: workerId,
                            aggregate_type: 'orchestration',
                            event_type: 'AgentFailed',
                            payload: {
                                worker_id: workerId,
                                task_id: taskId,
                                persona_id: personaId,
                                reason: 'heartbeat_stale_killed',
                                forced: true,
                            },
                            actor: SYSTEM_ACTOR,
                            capability_id: capabilityId,
                            trace_id: workerId,
                            occurred_at: new Date().toISOString(),
                            schema_version: 1,
                        });
                        this.children.delete(workerId);
                    })().catch((err) => {
                        logger.error({ err, workerId }, 'WorkerMonitor: failed to finalize worker termination');
                    });
                }, this.killGraceMs).unref?.();
            }
            else {
                // No tracked child — just mark terminated.
                await this.db
                    .update(agentWorkers)
                    .set({ status: 'terminated' })
                    .where(eq(agentWorkers.workerId, w.workerId));
                await this.eventStore.append({
                    aggregate_id: w.workerId,
                    aggregate_type: 'orchestration',
                    event_type: 'AgentFailed',
                    payload: {
                        worker_id: w.workerId,
                        task_id: w.taskId,
                        persona_id: w.personaId,
                        reason: 'heartbeat_stale_untracked',
                        forced: false,
                    },
                    actor: SYSTEM_ACTOR,
                    capability_id: w.capabilityId,
                    trace_id: w.workerId,
                    occurred_at: now.toISOString(),
                    schema_version: 1,
                });
            }
        }
        return timedOut;
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createWorkerMonitor(db, eventStore, options = {}) {
    return new WorkerMonitor(db, eventStore, options);
}
//# sourceMappingURL=monitor.js.map