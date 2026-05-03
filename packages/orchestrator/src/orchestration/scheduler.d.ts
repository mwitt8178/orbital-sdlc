/**
 * scheduler.ts — Scheduler.
 *
 * Per TRD-04 v0.2 §7 and §8, and SAO §5.1.
 *
 * Responsibilities:
 *   - Track active sprints with priority weights.
 *   - On every tick(), compute the per-sprint share via weighted equal-share +
 *     deficit accumulation; pick the next sprint to allocate a slot to.
 *   - For each available worker slot, find the most-eligible feasible task in
 *     the picked sprint (FIFO by tasks.ordering then created_at). Feasibility:
 *       (1) state IN ('pending','ready') and blocking predecessors all 'done'
 *       (2) no file-conflict with any in-progress task's declaredWritePaths
 *       (3) sprint not paused; pool not paused
 *   - Once a task is selected: route → issue capability → create worktree →
 *     spawn worker → mark task in_progress → emit AgentSpawned (via spawn()).
 *
 * Public API matches the Scheduler interface declared in the brief:
 *
 *   interface Scheduler {
 *     addSprint(s, tasks): void
 *     removeSprint(sprintId): void
 *     tick(): Promise<void>
 *     pause(sprintId): Promise<void>
 *     resume(sprintId): Promise<void>
 *   }
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { ICapabilityAuthority } from '../capabilities/authority.js';
import type { PersonaLoader } from '../personas/loader.js';
import type { RoutingEngine } from '../routing/engine.js';
import type { TaskRow, SchedulerSprint } from './types.js';
import { WorktreeManager } from './worktree.js';
import { type SpawnResult } from './spawn.js';
import type { WorkerMonitor } from './monitor.js';
import { PauseController } from './pause.js';
import type { CostEnforcer } from '../cost/enforcer.js';
import type { EscalationRaisedPayload } from '../events/types.js';
export interface SchedulerOptions {
    /** Max concurrent workers across all sprints. Default 8. */
    maxWorkers?: number;
    /** Per-spawn extra args (test surrogate; production leaves empty). */
    spawnExtraArgs?: string[];
    /** Override CLAUDE_BIN (test surrogate). */
    claudeBinOverride?: string;
    /** Override MCP gateway URL. */
    mcpGatewayUrl?: string;
    /** Optional callback for tests to observe each spawn result. */
    onSpawn?: (result: SpawnResult) => void;
    /**
     * Round5B — when true, the scheduler invokes spawn() in real-claude mode:
     * persona brief written to .orbital/persona.md, skill files copied into
     * .orbital/skills/, and the real `claude` CLI argument list constructed
     * from the brief.
     *
     * Default false: legacy behavior (CLAUDE_BIN + extraArgs only). Tests keep
     * this off; production turns it on via env or boot.
     */
    realClaude?: boolean;
    /**
     * Round 6 #5 — Cost Governance: optional cost enforcer.
     * When provided, canSpawn() is called before every spawn(). If the enforcer
     * returns allow=false the task is not spawned and BudgetExceeded is emitted.
     * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
     */
    costEnforcer?: CostEnforcer;
    /**
     * Active project id for cost scope resolution.
     * Passed through to costEnforcer.canSpawn().
     */
    projectId?: string;
}
export interface Scheduler {
    addSprint(sprint: SchedulerSprint, tasks: TaskRow[]): void;
    removeSprint(sprintId: string): void;
    tick(): Promise<void>;
    pause(sprintId: string): Promise<void>;
    resume(sprintId: string): Promise<void>;
    /** Test-only accessor for deficit map. */
    getDeficitFor(sprintId: string): number;
    /**
     * Round 6 #9 — Inter-Agent Channel Collaboration.
     * Called by the boot EventStore subscription when EscalationRaised fires.
     * The hook (post-escalation-raised) already created the child task in state='ready';
     * this method logs the event so the scheduler's next tick picks up the new task.
     * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
     */
    onEscalationRaised(payload: EscalationRaisedPayload): void;
}
export declare class DefaultScheduler implements Scheduler {
    private readonly db;
    private readonly eventStore;
    private readonly authority;
    private readonly personaLoader;
    private readonly routing;
    private readonly worktrees;
    private readonly monitor;
    private readonly pauseController;
    private readonly installId;
    private readonly maxWorkers;
    private readonly spawnExtraArgs;
    private readonly claudeBinOverride?;
    private readonly mcpGatewayUrl?;
    private readonly onSpawn?;
    private readonly realClaude;
    private readonly costEnforcer;
    private readonly projectId;
    private readonly sprints;
    private readonly sprintDeficit;
    private readonly children;
    /**
     * Monotonic per-process tick counter. Used to emit SchedulerTick events at
     * a coarse cadence so downstream rules (e.g., the agent-native
     * CeremonyScheduler's code-conflict rule) can run on tick boundaries
     * without subscribing to wall-clock time.
     */
    private tickSeq;
    constructor(db: DB, eventStore: EventStore, authority: ICapabilityAuthority, personaLoader: PersonaLoader, routing: RoutingEngine, worktrees: WorktreeManager, monitor: WorkerMonitor, pauseController: PauseController, installId: string, options?: SchedulerOptions);
    addSprint(sprint: SchedulerSprint, _tasks: TaskRow[]): void;
    removeSprint(sprintId: string): void;
    getDeficitFor(sprintId: string): number;
    /**
     * Called by the boot EventStore subscription when EscalationRaised fires.
     * The post-escalation-raised hook already created the child task in state='ready',
     * so the scheduler's next tick() will pick it up automatically via the feasibility
     * query. This method logs the event for observability and ensures the sprint that
     * owns the source task is still tracked.
     *
     * Round 6 #9 — Inter-Agent Channel Collaboration
     * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
     */
    onEscalationRaised(payload: EscalationRaisedPayload): void;
    pause(sprintId: string): Promise<void>;
    resume(sprintId: string): Promise<void>;
    tick(): Promise<void>;
    private pickSprint;
    private pickFeasibleTask;
    private pickFeasibleTaskAcross;
    private allocateSlot;
    private countActiveWorkers;
    /**
     * Collect declared_write_paths from in-progress tasks whose worker is still
     * alive (status != terminated/terminating). This narrows the BUSY set to
     * tasks that actually have a running agent — orphan in_progress rows from
     * crashed prior runs (or test pollution) are correctly ignored.
     *
     * Returns a flat array of glob patterns; the caller passes this to
     * worktrees.conflict().
     */
    private collectBusyPaths;
}
export declare function defaultTaskInsertDefaults(): {
    retryBudget: number;
    tokenBudget: number;
    wallClockTimeoutMs: number;
};
//# sourceMappingURL=scheduler.d.ts.map