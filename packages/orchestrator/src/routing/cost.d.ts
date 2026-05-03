/**
 * CostAccounting — per-turn cost calculation and budget enforcement.
 *
 * Per TRD-08 §4.2 (cost_accounting table), §7.3 (cost.report MCP tool),
 * §8.2–8.4 (events), §9 (budget enforcement).
 *
 * Rate table per task spec (per-million tokens, in USD micros):
 *   opus:   $15 in / $75 out / cache_read 10% of input / cache_write 1.25x input
 *   sonnet: $3 in  / $15 out / cache_read 10% of input / cache_write 1.25x input
 *   haiku:  $0.80 in / $4 out / cache_read 10% of input / cache_write 1.25x input
 *
 * Cost events written via EventStore, never direct db.insert(events).
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { AnthropicUsage, CostSummary, BudgetState } from './types.js';
import type { ModelId } from '../personas/types.js';
import type { SprintId, TaskId } from '@orbital/types';
/**
 * Compute cost in USD micros for a usage record.
 * Pure function; no I/O.
 */
export declare function computeCostMicros(model: ModelId, usage: AnthropicUsage): number;
export interface CostReportParams {
    taskId: TaskId;
    sessionId: string;
    sprintId: SprintId;
    ticketId?: string;
    model: ModelId;
    turnIndex: number;
    usage: AnthropicUsage;
    traceId: string;
    reportedAt?: string;
}
export interface CostReportResult {
    costId: string;
    costUsdMicros: number;
    cumulativeSessionUsdMicros: number;
    budgetState: BudgetState;
}
export interface CostAccounting {
    /**
     * Record a turn's cost; check budget caps; emit events.
     * Idempotent on (sessionId, turnIndex).
     */
    report(params: CostReportParams): Promise<CostReportResult>;
    /** Aggregate cost for a sprint. */
    getSprintTotal(sprintId: SprintId): Promise<CostSummary>;
    /** Aggregate cost for a task. */
    getTaskTotal(taskId: TaskId): Promise<CostSummary>;
}
export declare class PostgresCostAccounting implements CostAccounting {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    report(params: CostReportParams): Promise<CostReportResult>;
    getSprintTotal(sprintId: SprintId): Promise<CostSummary>;
    getTaskTotal(taskId: TaskId): Promise<CostSummary>;
    private checkAndUpdateBudgetCaps;
    private emitBudgetWarning;
    private emitBudgetExceeded;
}
export declare function createCostAccounting(db: DB, eventStore: EventStore): CostAccounting;
//# sourceMappingURL=cost.d.ts.map