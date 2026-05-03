/**
 * cost/types.ts — Cost domain type definitions.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */
export type BudgetScope = 'install' | 'project' | 'sprint';
export type OnSoftAction = 'alert' | 'pause' | 'none';
export type OnHardAction = 'pause' | 'kill' | 'alert_only';
export interface CostBudget {
    budgetId: string;
    scope: BudgetScope;
    scopeId: string | null;
    hardCapUsd: number;
    softThresholdPct: number;
    onSoft: OnSoftAction;
    onHard: OnHardAction;
    active: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface CostLedgerEntry {
    entryId: string;
    occurredAt: string;
    projectId: string;
    sprintId: string | null;
    taskId: string | null;
    workerId: string | null;
    personaId: string | null;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    requestId: string | null;
}
export interface AppendLedgerParams {
    projectId: string;
    sprintId?: string | null;
    taskId?: string | null;
    workerId?: string | null;
    personaId?: string | null;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    requestId?: string | null;
}
export type EnforcerAction = 'allow' | 'pause' | 'kill';
export interface EnforcerResult {
    allow: boolean;
    action: EnforcerAction;
    warn: boolean;
    reason?: string;
    runningCostUsd: number;
    estimatedCostUsd: number;
    hardCapUsd: number | null;
}
export interface CanSpawnParams {
    projectId: string;
    sprintId?: string | null;
    taskId?: string | null;
    /** Estimated token usage for the upcoming spawn. */
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
}
export interface CostSummary {
    projectId: string;
    sprintId: string | null;
    totalCostUsd: number;
    todayCostUsd: number;
    hardCapUsd: number | null;
    softThresholdPct: number;
    pctUsed: number;
    entryCount: number;
    windowStart: string;
    windowEnd: string;
}
export interface KillAllParams {
    scope: BudgetScope;
    scopeId: string;
    reason: string;
    actor: {
        type: string;
        id?: string;
    };
}
export interface KillAllResult {
    killedWorkerIds: string[];
    signalsSent: number;
}
export interface SetBudgetParams {
    scope: BudgetScope;
    scopeId?: string | null;
    hardCapUsd: number;
    softThresholdPct?: number;
    onSoft?: OnSoftAction;
    onHard?: OnHardAction;
}
//# sourceMappingURL=types.d.ts.map