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

import { uuidv7 } from 'uuidv7'
import { eq, and, sql as dSQL, sum, count } from 'drizzle-orm'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import { costBudgets, costLedger } from '@orbital/db'
import { computeCostUsd } from './pricing.js'
import { logger } from '../logger.js'
import type {
  AppendLedgerParams,
  CostBudget,
  CostSummary,
  SetBudgetParams,
  BudgetScope,
} from './types.js'
import type { CostLedgerAppendedPayload } from '../events/types.js'
import type { Actor } from '@orbital/types'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// CostService interface
// ---------------------------------------------------------------------------

export interface ICostService {
  appendLedger(params: AppendLedgerParams): Promise<{ entryId: string; costUsd: number }>
  getBudget(scope: BudgetScope, scopeId: string | null): Promise<CostBudget | null>
  setBudget(params: SetBudgetParams): Promise<CostBudget>
  summarize(projectId: string, sprintId?: string | null): Promise<CostSummary>
  getRunningCost(scope: BudgetScope, scopeId: string): Promise<number>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CostService implements ICostService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly installId: string,
  ) {}

  /**
   * Write a cost_ledger row after a successful (or failed-with-usage) LLM call.
   * Computes cost_usd from the pricing table at write time.
   * Emits CostLedgerAppended event.
   */
  async appendLedger(
    params: AppendLedgerParams,
  ): Promise<{ entryId: string; costUsd: number }> {
    const entryId = uuidv7()
    const costUsd = computeCostUsd(params.model, {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
    })

    await this.db.insert(costLedger).values({
      entryId,
      projectId: params.projectId,
      sprintId:  params.sprintId  ?? null,
      taskId:    params.taskId    ?? null,
      workerId:  params.workerId  ?? null,
      personaId: params.personaId ?? null,
      model:     params.model,
      provider:  params.provider,
      inputTokens:       params.inputTokens,
      outputTokens:      params.outputTokens,
      cacheReadTokens:   params.cacheReadTokens  ?? 0,
      cacheWriteTokens:  params.cacheWriteTokens ?? 0,
      costUsd:   String(costUsd),
      requestId: params.requestId ?? null,
    })

    // Emit CostLedgerAppended for frontend live-burn subscription.
    const payload: CostLedgerAppendedPayload = {
      entry_id:            entryId,
      project_id:          params.projectId,
      sprint_id:           params.sprintId ?? null,
      task_id:             params.taskId   ?? null,
      worker_id:           params.workerId ?? null,
      persona_id:          params.personaId ?? null,
      model:               params.model,
      provider:            params.provider,
      input_tokens:        params.inputTokens,
      output_tokens:       params.outputTokens,
      cache_read_tokens:   params.cacheReadTokens  ?? 0,
      cache_write_tokens:  params.cacheWriteTokens ?? 0,
      cost_usd:            costUsd,
      occurred_at:         new Date().toISOString(),
    }

    try {
      await this.eventStore.append({
        aggregate_id:   params.projectId,
        aggregate_type: 'install',
        event_type:     'CostLedgerAppended',
        payload:        payload as unknown as Record<string, unknown>,
        actor:          SYSTEM_ACTOR,
        trace_id:       uuidv7(),
        occurred_at:    payload.occurred_at,
        schema_version: 1,
      })
    } catch (err) {
      // Event emission is best-effort; don't fail the ledger write.
      logger.warn({ err, entryId }, 'CostService.appendLedger: event emit failed (non-fatal)')
    }

    logger.debug(
      { entryId, model: params.model, costUsd, projectId: params.projectId },
      'CostService.appendLedger: wrote entry',
    )

    return { entryId, costUsd }
  }

  /**
   * Fetch the active budget for a scope/scopeId pair.
   * Returns null when no budget is configured.
   */
  async getBudget(scope: BudgetScope, scopeId: string | null): Promise<CostBudget | null> {
    const rows = await this.db
      .select()
      .from(costBudgets)
      .where(
        and(
          eq(costBudgets.scope, scope),
          scopeId !== null
            ? eq(costBudgets.scopeId, scopeId)
            : dSQL`${costBudgets.scopeId} IS NULL`,
          eq(costBudgets.active, true),
        ),
      )
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return {
      budgetId:         row.budgetId,
      scope:            row.scope as BudgetScope,
      scopeId:          row.scopeId ?? null,
      hardCapUsd:       Number(row.hardCapUsd),
      softThresholdPct: row.softThresholdPct,
      onSoft:           row.onSoft as 'alert' | 'pause' | 'none',
      onHard:           row.onHard as 'pause' | 'kill' | 'alert_only',
      active:           row.active,
      createdAt:        row.createdAt.toISOString(),
      updatedAt:        row.updatedAt.toISOString(),
    }
  }

  /**
   * Upsert a budget for a scope. Deactivates the prior row for the scope and
   * inserts a new one (simpler than UPDATE + partial-index race).
   */
  async setBudget(params: SetBudgetParams): Promise<CostBudget> {
    const budgetId = uuidv7()
    const now = new Date()

    // Deactivate any existing active budget for this scope.
    await this.db
      .update(costBudgets)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(costBudgets.scope, params.scope),
          params.scopeId != null
            ? eq(costBudgets.scopeId, params.scopeId)
            : dSQL`${costBudgets.scopeId} IS NULL`,
          eq(costBudgets.active, true),
        ),
      )

    await this.db.insert(costBudgets).values({
      budgetId,
      scope:            params.scope,
      scopeId:          params.scopeId ?? null,
      hardCapUsd:       String(params.hardCapUsd),
      softThresholdPct: params.softThresholdPct ?? 80,
      onSoft:           params.onSoft ?? 'alert',
      onHard:           params.onHard ?? 'pause',
      active:           true,
      createdAt:        now,
      updatedAt:        now,
    })

    return {
      budgetId,
      scope:            params.scope,
      scopeId:          params.scopeId ?? null,
      hardCapUsd:       params.hardCapUsd,
      softThresholdPct: params.softThresholdPct ?? 80,
      onSoft:           params.onSoft ?? 'alert',
      onHard:           params.onHard ?? 'pause',
      active:           true,
      createdAt:        now.toISOString(),
      updatedAt:        now.toISOString(),
    }
  }

  /**
   * Aggregate cost_usd for a project (optionally scoped to a sprint).
   * Returns a CostSummary with today's cost and total.
   */
  async summarize(projectId: string, sprintId?: string | null): Promise<CostSummary> {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)

    // Total for the project (or sprint if provided).
    const totalRows = await this.db
      .select({
        totalCostUsd: sum(costLedger.costUsd),
        entryCount:   count(),
      })
      .from(costLedger)
      .where(
        sprintId
          ? and(eq(costLedger.projectId, projectId), eq(costLedger.sprintId, sprintId))
          : eq(costLedger.projectId, projectId),
      )

    // Today's spend.
    const todayRows = await this.db
      .select({ todayCostUsd: sum(costLedger.costUsd) })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.projectId, projectId),
          ...(sprintId ? [eq(costLedger.sprintId, sprintId)] : []),
          dSQL`${costLedger.occurredAt} >= ${todayStart}`,
        ),
      )

    const totalCostUsd = Number(totalRows[0]?.totalCostUsd ?? 0)
    const todayCostUsd = Number(todayRows[0]?.todayCostUsd ?? 0)
    const entryCount   = Number(totalRows[0]?.entryCount   ?? 0)

    // Fetch budget for context.
    const budget = sprintId
      ? await this.getBudget('sprint', sprintId)
      : await this.getBudget('project', projectId)

    const hardCapUsd      = budget?.hardCapUsd ?? null
    const softThresholdPct = budget?.softThresholdPct ?? 80
    const pctUsed         = hardCapUsd ? totalCostUsd / hardCapUsd : 0

    return {
      projectId,
      sprintId:          sprintId ?? null,
      totalCostUsd,
      todayCostUsd,
      hardCapUsd,
      softThresholdPct,
      pctUsed,
      entryCount,
      windowStart:       todayStart.toISOString(),
      windowEnd:         now.toISOString(),
    }
  }

  /**
   * Sum cost_usd for a scope window (used by enforcer before spawn).
   */
  async getRunningCost(scope: BudgetScope, scopeId: string): Promise<number> {
    let rows
    if (scope === 'sprint') {
      rows = await this.db
        .select({ total: sum(costLedger.costUsd) })
        .from(costLedger)
        .where(eq(costLedger.sprintId, scopeId))
    } else if (scope === 'project') {
      rows = await this.db
        .select({ total: sum(costLedger.costUsd) })
        .from(costLedger)
        .where(eq(costLedger.projectId, scopeId))
    } else {
      // install scope: sum all
      rows = await this.db
        .select({ total: sum(costLedger.costUsd) })
        .from(costLedger)
    }
    return Number(rows[0]?.total ?? 0)
  }
}

// ---------------------------------------------------------------------------
// Singleton registry (for tRPC router + scheduler DI)
// ---------------------------------------------------------------------------

let _costService: CostService | null = null

export function registerCostService(svc: CostService): void {
  _costService = svc
}

export function getCostService(): CostService {
  if (!_costService) {
    throw new Error('STARTUP_ERROR: CostService not registered. Call registerCostService() at boot.')
  }
  return _costService
}

export function createCostService(db: DB, eventStore: EventStore, installId: string): CostService {
  return new CostService(db, eventStore, installId)
}
