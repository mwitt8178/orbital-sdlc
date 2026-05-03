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
import type { ChildProcess } from 'node:child_process';
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
export interface WorkerMonitorOptions {
    /** Polling interval. Default 10s. */
    pollIntervalMs?: number;
    /** Heartbeat timeout. Default 90s. */
    heartbeatTimeoutMs?: number;
    /** SIGTERM→SIGKILL grace. Default 5s. */
    killGraceMs?: number;
    /** Custom now() — used by tests for deterministic timing. */
    nowFn?: () => Date;
}
export declare class WorkerMonitor {
    private readonly db;
    private readonly eventStore;
    private readonly children;
    private readonly pollIntervalMs;
    private readonly heartbeatTimeoutMs;
    private readonly killGraceMs;
    private readonly nowFn;
    private timer;
    constructor(db: DB, eventStore: EventStore, options?: WorkerMonitorOptions);
    /** Register a ChildProcess handle so the monitor can signal it. */
    track(workerId: string, child: ChildProcess): void;
    /** Forget a worker's handle (e.g. after task.complete revokes capability). */
    untrack(workerId: string): void;
    /** Start the polling loop. */
    start(): void;
    /** Stop the polling loop. */
    stop(): void;
    /**
     * Run a single poll. Returns the workerIds that were timed-out this tick.
     * Public so tests can drive deterministically.
     */
    tick(): Promise<string[]>;
}
export declare function createWorkerMonitor(db: DB, eventStore: EventStore, options?: WorkerMonitorOptions): WorkerMonitor;
//# sourceMappingURL=monitor.d.ts.map