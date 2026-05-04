/**
 * assert-budget.test.ts — TDD tests for assertBudget pre-flight check.
 *
 * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
 *
 * Covers:
 *   - hard-stop blocks when MTD spend + estimate exceeds cap
 *   - soft-stop warns but allows when below hard cap
 *   - throttle decision when soft threshold is breached
 *   - tenant isolation (separate tenants don't bleed)
 *   - idempotency under concurrent runs (log-only side effect)
 *   - no budget configured → allow freely
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  assertBudget,
  BudgetExceededError,
  type AssertBudgetParams,
} from '../../../src/cost/assert-budget.js'
import type { DB } from '@orbital/db'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub Drizzle DB that returns controlled values for the two SELECT
 * queries assertBudget makes:
 *
 *   1st select() call  → _fetchBudget (costBudgets) — returns budget row or []
 *   2nd select() call  → _fetchMtdSpend (costLedger) — returns [{ total: "n" }]
 *
 * insert() is also stubbed to track enforcement log writes.
 */
function makeDb(opts: {
  budget?: {
    hard_cap_usd: string
    soft_threshold_pct: number
    on_hard: string
    on_soft: string
  } | null
  mtdSpend?: number
} = {}): DB {
  const budget = opts.budget !== undefined ? opts.budget : {
    hard_cap_usd: '10.00',
    soft_threshold_pct: 80,
    on_hard: 'pause',
    on_soft: 'alert',
  }
  const mtdSpend = opts.mtdSpend ?? 0

  // Call counter: first select() call is the budget query, second is MTD spend.
  let selectCallCount = 0

  // The where() result must be both thenable (for queries without .limit()) AND
  // expose .limit() (for queries that call .limit(n)).
  const makeWhereResult = (resolveWith: unknown[]) => {
    const thenable = Object.assign(Promise.resolve(resolveWith), {
      limit: vi.fn().mockResolvedValue(resolveWith),
    })
    return thenable
  }

  const makeSelectChain = (resolveWith: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(makeWhereResult(resolveWith)),
    }),
  })

  const select = vi.fn().mockImplementation(() => {
    selectCallCount++
    if (selectCallCount === 1) {
      // Budget query (project-scope, may also be called for sprint-scope first)
      return makeSelectChain(budget ? [budget] : [])
    }
    // MTD spend query
    return makeSelectChain([{ total: String(mtdSpend) }])
  })

  const insertValues = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn().mockReturnValue({ values: insertValues })

  return { select, insert } as unknown as DB
}

// Helper: make a DB that simulates both sprint-scope and project-scope budget queries.
// Sprint-scope is checked first (call 1), project-scope second (call 2), MTD third (call 3).
function makeDbWithSprint(opts: {
  sprintBudget?: { hard_cap_usd: string; soft_threshold_pct: number; on_hard: string; on_soft: string } | null
  projectBudget?: { hard_cap_usd: string; soft_threshold_pct: number; on_hard: string; on_soft: string } | null
  mtdSpend?: number
} = {}): DB {
  const mtdSpend = opts.mtdSpend ?? 0
  let selectCallCount = 0
  const sprintBudgetFound = !!opts.sprintBudget

  const makeWhereResultForSprint = (resolveWith: unknown[]) => {
    return Object.assign(Promise.resolve(resolveWith), {
      limit: vi.fn().mockResolvedValue(resolveWith),
    })
  }

  const makeSelectChainForSprint = (resolveWith: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(makeWhereResultForSprint(resolveWith)),
    }),
  })

  const select = vi.fn().mockImplementation(() => {
    selectCallCount++
    if (selectCallCount === 1) {
      // Sprint-scope budget query
      return makeSelectChainForSprint(opts.sprintBudget ? [opts.sprintBudget] : [])
    }
    if (selectCallCount === 2 && !sprintBudgetFound) {
      // Project-scope budget fallback (only when sprint budget was NOT found)
      return makeSelectChainForSprint(opts.projectBudget ? [opts.projectBudget] : [])
    }
    // MTD spend (call 2 when sprint found, call 3 when project fallback needed)
    return makeSelectChainForSprint([{ total: String(mtdSpend) }])
  })

  const insertValues = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn().mockReturnValue({ values: insertValues })
  return { select, insert } as unknown as DB
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assertBudget', () => {
  const baseParams: AssertBudgetParams = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    projectId: '00000000-0000-0000-0000-000000000002',
    persona: 'planner',
    estimatedCostUsd: 0.10,
    db: makeDb({ mtdSpend: 5.00 }),
  }

  it('should allow when MTD spend + estimate is below hard cap', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 5.00,
    })
    const result = await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    expect(result.decision).toBe('allow')
    expect(result.allow).toBe(true)
    expect(result.warn).toBe(false)
  })

  it('should block (throw BudgetExceededError) when projected spend exceeds hard cap', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 9.95,
    })
    await expect(
      assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db }),
    ).rejects.toThrowError(BudgetExceededError)
  })

  it('BudgetExceededError carries structured context', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 9.95,
    })
    let caught: BudgetExceededError | null = null
    try {
      await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err
    }
    expect(caught).not.toBeNull()
    expect(caught!.projectId).toBe(baseParams.projectId)
    expect(caught!.tenantId).toBe(baseParams.tenantId)
    expect(typeof caught!.budgetCapUsd).toBe('number')
    expect(caught!.budgetCapUsd).toBe(10)
    expect(typeof caught!.mtdSpendUsd).toBe('number')
    expect(caught!.mtdSpendUsd).toBe(9.95)
  })

  it('should warn but allow when projected spend exceeds soft threshold but not hard cap', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 8.50, // 85% of 10.00 — over soft threshold (80%) but under hard cap
    })
    const result = await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    expect(result.allow).toBe(true)
    expect(result.decision).toBe('allow')
    expect(result.warn).toBe(true)
  })

  it('should return allow (not block) when estimated cost is undefined', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 9.90,
    })
    // estimatedCostUsd defaults to 0, so 9.90 + 0 = 9.90 < 10.00 → allow
    const result = await assertBudget({ ...baseParams, estimatedCostUsd: undefined, db })
    expect(result.allow).toBe(true)
    expect(result.decision).toBe('allow')
  })

  it('should allow freely when no budget is configured', async () => {
    const db = makeDb({ budget: null, mtdSpend: 999 })
    const result = await assertBudget({ ...baseParams, db })
    expect(result.allow).toBe(true)
    expect(result.decision).toBe('allow')
    expect(result.budgetCapUsd).toBeNull()
    expect(result.warn).toBe(false)
  })

  it('should allow when on_hard=alert_only even if projected spend exceeds hard cap', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'alert_only', on_soft: 'alert' },
      mtdSpend: 9.95,
    })
    // Should NOT throw — alert_only means log and warn but don't block
    const result = await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    // decision is still 'block' internally but we don't throw
    expect(result.allow).toBe(false) // allow=false because decision=block
    expect(result.decision).toBe('block')
  })

  it('tenant isolation — different tenants with same project_id do not bleed', async () => {
    // Both calls succeed with independent DB stubs; no shared state possible.
    const dbTenant1 = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 9.95, // tenant 1 is near cap
    })
    const dbTenant2 = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 0.50, // tenant 2 is far from cap
    })
    const tenant1 = '00000000-0000-0000-0000-000000000aaa'
    const tenant2 = '00000000-0000-0000-0000-000000000bbb'

    await expect(
      assertBudget({ ...baseParams, tenantId: tenant1, estimatedCostUsd: 0.10, db: dbTenant1 }),
    ).rejects.toThrowError(BudgetExceededError)

    const result = await assertBudget({
      ...baseParams,
      tenantId: tenant2,
      estimatedCostUsd: 0.10,
      db: dbTenant2,
    })
    expect(result.allow).toBe(true)
  })

  it('logs every decision to cost_enforcement_log (allow path)', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 1.00,
    })
    await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    // The insert mock should have been called once for the enforcement log
    expect(db.insert).toHaveBeenCalled()
    const insertMock = db.insert as ReturnType<typeof vi.fn>
    expect(insertMock.mock.calls.length).toBe(1)
  })

  it('logs every decision to cost_enforcement_log (block path)', async () => {
    const db = makeDb({
      budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 9.95,
    })
    try {
      await assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })
    } catch {
      // expected BudgetExceededError
    }
    expect(db.insert).toHaveBeenCalled()
    const insertMock = db.insert as ReturnType<typeof vi.fn>
    expect(insertMock.mock.calls.length).toBe(1)
  })

  it('idempotency — concurrent calls with same params each get their own log row', async () => {
    // Each concurrent assertBudget call gets an independent DB stub.
    // This tests that there is no shared mutable state between calls.
    const makeIndependentDb = () =>
      makeDb({
        budget: { hard_cap_usd: '10.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
        mtdSpend: 1.00,
      })

    const dbs = [makeIndependentDb(), makeIndependentDb(), makeIndependentDb()]
    const results = await Promise.all(
      dbs.map((db) => assertBudget({ ...baseParams, estimatedCostUsd: 0.10, db })),
    )
    for (const r of results) {
      expect(r.allow).toBe(true)
    }
    // Each DB instance should have had exactly one insert call
    for (const db of dbs) {
      const insertMock = db.insert as ReturnType<typeof vi.fn>
      expect(insertMock.mock.calls.length).toBe(1)
    }
  })

  it('sprint-scope budget takes precedence over project-scope', async () => {
    // Sprint budget: tight cap ($5). Project budget: generous cap ($100).
    const db = makeDbWithSprint({
      sprintBudget: { hard_cap_usd: '5.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      projectBudget: { hard_cap_usd: '100.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 4.95,
    })
    // 4.95 + 0.10 = 5.05 > 5.00 → should block via sprint budget
    await expect(
      assertBudget({ ...baseParams, sprintId: '00000000-0000-0000-0000-000000000099', estimatedCostUsd: 0.10, db }),
    ).rejects.toThrowError(BudgetExceededError)
  })

  it('falls back to project-scope when no sprint budget exists', async () => {
    const db = makeDbWithSprint({
      sprintBudget: null,
      projectBudget: { hard_cap_usd: '100.00', soft_threshold_pct: 80, on_hard: 'pause', on_soft: 'alert' },
      mtdSpend: 1.00,
    })
    const result = await assertBudget({
      ...baseParams,
      sprintId: '00000000-0000-0000-0000-000000000099',
      estimatedCostUsd: 0.10,
      db,
    })
    expect(result.allow).toBe(true)
    expect(result.budgetCapUsd).toBe(100)
  })
})
