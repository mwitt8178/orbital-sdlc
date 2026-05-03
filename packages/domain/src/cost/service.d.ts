/**
 * cost/service.ts — CostService: ledger append, budget read, summary.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Responsibilities:
 *   - appendLedger: write a cost_ledger row after each LLM call.
 *   - getBudget: fetch the active budget for a scope.
 *   - setBudget: upsert a cost_budgets row.
 *   - summarize: aggregate cost_ledger for a project/sprint window.
 *   - getRunningCost: sum cost_usd for a scope (for enforcer use).
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { AppendLedgerParams, CostBudget, CostSummary, SetBudgetParams, BudgetScope } from './types.js';
export interface ICostService {
    appendLedger(params: AppendLedgerParams): Promise<{
        entryId: string;
        costUsd: number;
    }>;
    getBudget(scope: BudgetScope, scopeId: string | null): Promise<CostBudget | null>;
    setBudget(params: SetBudgetParams): Promise<CostBudget>;
    summarize(projectId: string, sprintId?: string | null): Promise<CostSummary>;
    getRunningCost(scope: BudgetScope, scopeId: string): Promise<number>;
}
export declare class CostService implements ICostService {
    private readonly db;
    private readonly eventStore;
    private readonly installId;
    constructor(db: DB, eventStore: EventStore, installId: string);
    /**
     * Write a cost_ledger row after a successful (or failed-with-usage) LLM call.
     * Computes cost_usd from the pricing table at write time.
     * Emits CostLedgerAppended event.
     */
    appendLedger(params: AppendLedgerParams): Promise<{
        entryId: string;
        costUsd: number;
    }>;
    /**
     * Fetch the active budget for a scope/scopeId pair.
     * Returns null when no budget is configured.
     */
    getBudget(scope: BudgetScope, scopeId: string | null): Promise<CostBudget | null>;
    /**
     * Upsert a budget for a scope. Deactivates the prior row for the scope and
     * inserts a new one (simpler than UPDATE + partial-index race).
     */
    setBudget(params: SetBudgetParams): Promise<CostBudget>;
    /**
     * Aggregate cost_usd for a project (optionally scoped to a sprint).
     * Returns a CostSummary with today's cost and total.
     */
    summarize(projectId: string, sprintId?: string | null): Promise<CostSummary>;
    /**
     * Sum cost_usd for a scope window (used by enforcer before spawn).
     */
    getRunningCost(scope: BudgetScope, scopeId: string): Promise<number>;
}
export declare function registerCostService(svc: CostService): void;
export declare function getCostService(): CostService;
export declare function createCostService(db: DB, eventStore: EventStore, installId: string): CostService;
//# sourceMappingURL=service.d.ts.map