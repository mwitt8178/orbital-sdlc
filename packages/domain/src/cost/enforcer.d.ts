/**
 * cost/enforcer.ts — CostEnforcer: pre-spawn budget check + live kill switch.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Flow (pre-spawn):
 *   canSpawn(projectId, sprintId?, estimatedTokens?)
 *     → sum cost_ledger for the narrowest configured scope
 *     → if running + estimated > hard_cap → { allow: false, action: 'pause' }
 *     → if running + estimated > soft_threshold → { allow: true, warn: true }
 *     → else { allow: true }
 *
 * Flow (post-call live check):
 *   checkLive(projectId, sprintId?)
 *     → if running > hard_cap AND on_hard === 'kill' → emit KillSwitchTripped + SIGTERM all workers
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { CostService } from './service.js';
import type { EnforcerResult, CanSpawnParams } from './types.js';
export declare class CostEnforcer {
    private readonly db;
    private readonly eventStore;
    private readonly costService;
    /** Inject for tests. Defaults to process.kill. */
    private readonly killFn;
    constructor(db: DB, eventStore: EventStore, costService: CostService, 
    /** Inject for tests. Defaults to process.kill. */
    killFn?: (pid: number, signal: NodeJS.Signals) => void);
    /**
     * Check whether a spawn is allowed given the current running cost
     * and the estimated cost of the task about to be launched.
     *
     * Checked scopes (most-specific first): sprint, project, install.
     * Returns the most restrictive result across all configured budgets.
     */
    canSpawn(params: CanSpawnParams): Promise<EnforcerResult>;
    /**
     * Live check after a ledger entry is written.
     * If running cost exceeds hard cap and on_hard === 'kill', SIGTERM all workers.
     */
    checkLive(projectId: string, sprintId?: string | null): Promise<void>;
    /**
     * Operator-initiated kill: SIGTERM all workers in the given scope.
     */
    killAll(scope: 'install' | 'project' | 'sprint', scopeId: string, reason: string, actorId: string): Promise<{
        killedWorkerIds: string[];
        signalsSent: number;
    }>;
    private _evaluate;
    private _emitBudgetExceeded;
    private _killAllInScope;
}
export declare function registerCostEnforcer(enforcer: CostEnforcer): void;
export declare function getCostEnforcer(): CostEnforcer;
export declare function createCostEnforcer(db: DB, eventStore: EventStore, costService: CostService, killFn?: (pid: number, signal: NodeJS.Signals) => void): CostEnforcer;
//# sourceMappingURL=enforcer.d.ts.map