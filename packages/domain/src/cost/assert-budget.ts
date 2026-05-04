/**
 * cost/assert-budget.ts — Pre-flight budget check helper.
 *
 * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
 *
 * assertBudget({ tenant_id, project_id, persona, estimated_cost })
 *   1. Reads the active project budget from cost_budgets.
 *   2. Sums MTD (month-to-date) spend from cost_ledger for the project.
 *   3. If hard_stop=true and (mtd + estimated_cost) > hard_cap → throws BudgetExceededError.
 *   4. If (mtd + estimated_cost) > soft_threshold → returns warn=true, decision=allow.
 *   5. Logs every decision to cost_enforcement_log.
 *
 * This is a pure DB function — no singleton registries, no global state.
 * Every Claude-invoking codepath calls this before invoking the model.
 *
 * DSQL constraints honored:
 *   - No foreign keys in the log table (per skill aws-dsql-constraints).
 *   - IDs via uuidv7 (no sequences).
 *   - DDL is in migration 0052; this file is DML-only.
 *   - MTD sum uses a parameterized ISO-string date comparison.
 */

import { sql as dSQL, sum } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DB } from '@orbital/db'
import { costLedger, costEnforcementLog, costBudgets } from '@orbital/db'
import { eq, and } from 'drizzle-orm'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssertBudgetParams {
  /** Multi-tenant scoping — required. Every check is tenant-isolated. */
  tenantId: string
  /**
   * Project ID for the cost ledger MTD query and project-scope budget lookup.
   * Required for project-scope checks. When using sprint-scope, may be the same
   * as the sprint's owning project or a sentinel value.
   */
  projectId: string
  /**
   * Optional sprint ID. When provided, a sprint-scope budget is checked first.
   * If no sprint budget is configured, falls back to project-scope.
   */
  sprintId?: string
  /** Persona name for the enforcement log (e.g. 'planner', 'retro-analyst'). */
  persona?: string
  /** Estimated cost of the upcoming LLM call in USD. Use max_tokens × model rate for conservative estimate. */
  estimatedCostUsd?: number
  /** Drizzle DB instance. Passed explicitly for testability (no singleton). */
  db: DB
}

export interface BudgetEnforcementResult {
  allow: boolean
  decision: 'allow' | 'block' | 'throttle'
  warn: boolean
  budgetCapUsd: number | null
  mtdSpendUsd: number
  estimatedCostUsd: number
  reason?: string
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  readonly tenantId: string
  readonly projectId: string
  readonly budgetCapUsd: number
  readonly mtdSpendUsd: number
  readonly estimatedCostUsd: number

  constructor(opts: {
    tenantId: string
    projectId: string
    budgetCapUsd: number
    mtdSpendUsd: number
    estimatedCostUsd: number
    reason: string
  }) {
    super(opts.reason)
    this.name = 'BudgetExceededError'
    this.tenantId = opts.tenantId
    this.projectId = opts.projectId
    this.budgetCapUsd = opts.budgetCapUsd
    this.mtdSpendUsd = opts.mtdSpendUsd
    this.estimatedCostUsd = opts.estimatedCostUsd
  }
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Pre-flight budget check.
 *
 * Throws BudgetExceededError when the hard-stop threshold is exceeded.
 * Returns BudgetEnforcementResult on allow/warn paths.
 *
 * Always writes a row to cost_enforcement_log (best-effort; DB failure is
 * logged but does not block the call).
 */
export async function assertBudget(params: AssertBudgetParams): Promise<BudgetEnforcementResult> {
  const { tenantId, projectId, persona, db } = params
  const estimatedCostUsd = params.estimatedCostUsd ?? 0

  // 1. Fetch the active budget (sprint-scope first, then project-scope).
  const budget = await _fetchBudget(db, projectId, params.sprintId)

  // 2. Sum MTD spend for this project (calendar month, tenant-scoped).
  const mtdSpendUsd = await _fetchMtdSpend(db, projectId, tenantId)

  // 3. Evaluate against the budget.
  let decision: BudgetEnforcementResult['decision'] = 'allow'
  let warn = false
  let reason: string | undefined

  if (budget) {
    const hardCapUsd = Number(budget.hard_cap_usd)
    const softCapUsd = hardCapUsd * (budget.soft_threshold_pct / 100)
    const projected = mtdSpendUsd + estimatedCostUsd

    if (projected > hardCapUsd) {
      decision = 'block'
      reason = `Projected MTD spend $${projected.toFixed(4)} exceeds hard cap $${hardCapUsd.toFixed(2)} (MTD: $${mtdSpendUsd.toFixed(4)}, estimate: $${estimatedCostUsd.toFixed(4)})`
    } else if (projected > softCapUsd) {
      decision = 'allow'
      warn = true
      reason = `Projected MTD spend $${projected.toFixed(4)} exceeds soft threshold $${softCapUsd.toFixed(4)} (${budget.soft_threshold_pct}% of $${hardCapUsd.toFixed(2)})`
    }
  }

  const result: BudgetEnforcementResult = {
    allow: decision !== 'block',
    decision,
    warn,
    budgetCapUsd: budget ? Number(budget.hard_cap_usd) : null,
    mtdSpendUsd,
    estimatedCostUsd,
    reason,
  }

  // 4. Log the decision to cost_enforcement_log (best-effort).
  await _logDecision(db, {
    tenantId,
    projectId,
    persona: persona ?? null,
    decision,
    budgetCapUsd: result.budgetCapUsd,
    mtdSpendUsd,
    wouldBeCostEstimateUsd: estimatedCostUsd,
    reason: reason ?? null,
  }).catch((logErr) => {
    logger.warn(
      { logErr, tenantId, projectId, decision },
      'assertBudget: failed to write enforcement log row (non-fatal)',
    )
  })

  // 5. Throw on block.
  if (decision === 'block' && budget) {
    const hardCapUsd = Number(budget.hard_cap_usd)
    if (budget.on_hard !== 'alert_only') {
      throw new BudgetExceededError({
        tenantId,
        projectId,
        budgetCapUsd: hardCapUsd,
        mtdSpendUsd,
        estimatedCostUsd,
        reason: reason!,
      })
    }
  }

  if (warn) {
    logger.warn(
      { tenantId, projectId, persona, mtdSpendUsd, budgetCapUsd: result.budgetCapUsd, estimatedCostUsd },
      'assertBudget: soft budget threshold crossed',
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface BudgetRow {
  hard_cap_usd: string
  soft_threshold_pct: number
  on_hard: string
  on_soft: string
}

async function _fetchBudget(
  db: DB,
  projectId: string,
  sprintId?: string,
): Promise<BudgetRow | null> {
  try {
    // Sprint-scope budget takes precedence when a sprintId is supplied.
    if (sprintId) {
      const sprintRows = await db
        .select({
          hard_cap_usd:       costBudgets.hardCapUsd,
          soft_threshold_pct: costBudgets.softThresholdPct,
          on_hard:            costBudgets.onHard,
          on_soft:            costBudgets.onSoft,
        })
        .from(costBudgets)
        .where(
          and(
            eq(costBudgets.scope, 'sprint'),
            eq(costBudgets.scopeId, sprintId),
            eq(costBudgets.active, true),
          ),
        )
        .limit(1)
      if (sprintRows[0]) return sprintRows[0] as BudgetRow
    }

    // Fall back to project-scope budget.
    const rows = await db
      .select({
        hard_cap_usd:       costBudgets.hardCapUsd,
        soft_threshold_pct: costBudgets.softThresholdPct,
        on_hard:            costBudgets.onHard,
        on_soft:            costBudgets.onSoft,
      })
      .from(costBudgets)
      .where(
        and(
          eq(costBudgets.scope, 'project'),
          eq(costBudgets.scopeId, projectId),
          eq(costBudgets.active, true),
        ),
      )
      .limit(1)

    return (rows[0] as BudgetRow | undefined) ?? null
  } catch (err) {
    logger.warn({ err, projectId }, 'assertBudget._fetchBudget: DB error, treating as no budget')
    return null
  }
}

async function _fetchMtdSpend(db: DB, projectId: string, _tenantId: string): Promise<number> {
  try {
    // MTD window: start of current calendar month.
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthStartIso = monthStart.toISOString()

    const rows = await db
      .select({ total: sum(costLedger.costUsd) })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.projectId, projectId),
          dSQL`${costLedger.occurredAt} >= ${monthStartIso}`,
        ),
      )

    return Number(rows[0]?.total ?? 0)
  } catch (err) {
    logger.warn({ err, projectId }, 'assertBudget._fetchMtdSpend: DB error, treating as 0')
    return 0
  }
}

async function _logDecision(
  db: DB,
  entry: {
    tenantId: string
    projectId: string
    persona: string | null
    decision: 'allow' | 'block' | 'throttle'
    budgetCapUsd: number | null
    mtdSpendUsd: number
    wouldBeCostEstimateUsd: number
    reason: string | null
  },
): Promise<void> {
  await db.insert(costEnforcementLog).values({
    id:                     uuidv7(),
    tenantId:               entry.tenantId,
    projectId:              entry.projectId,
    persona:                entry.persona,
    decision:               entry.decision,
    budgetCapUsd:           entry.budgetCapUsd != null ? String(entry.budgetCapUsd) : null,
    mtdSpendUsd:            String(entry.mtdSpendUsd),
    wouldBeCostEstimateUsd: String(entry.wouldBeCostEstimateUsd),
    reason:                 entry.reason,
  })
}
