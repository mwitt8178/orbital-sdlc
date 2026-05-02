/**
 * Integration test: budget enforcement — AC #3
 *
 * Scenario: set sprint hard_cap=$0.10 → run 3 fake-worker tasks each costing
 * $0.05 → assert third task does NOT spawn + BudgetExceeded event written.
 *
 * Uses real Postgres. Stubs only the LLM HTTP boundary.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { sql as drizzleSql } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createCostService } from '../../../src/cost/service.js'
import { createCostEnforcer } from '../../../src/cost/enforcer.js'
import { costBudgets, costLedger } from '../../../src/db/schema/cost.js'
import { events as eventsTable } from '../../../src/db/schema/events.js'

let installId: string
let eventStore: ReturnType<typeof createEventStore>

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedBudget(
  scope: 'sprint' | 'project',
  scopeId: string,
  hardCapUsd: number,
): Promise<void> {
  await db.insert(costBudgets).values({
    budgetId:         uuidv7(),
    scope,
    scopeId,
    hardCapUsd:       String(hardCapUsd),
    softThresholdPct: 80,
    onSoft:           'alert',
    onHard:           'pause',
    active:           true,
    createdAt:        new Date(),
    updatedAt:        new Date(),
  })
}

async function writeFakeLedgerEntry(
  projectId: string,
  sprintId: string,
  costUsd: number,
): Promise<void> {
  await db.insert(costLedger).values({
    entryId:     uuidv7(),
    projectId,
    sprintId,
    model:       'claude-sonnet-4-6',
    provider:    'anthropic',
    inputTokens:  1000,
    outputTokens: 500,
    cacheReadTokens:  0,
    cacheWriteTokens: 0,
    costUsd:     String(costUsd),
  })
}

async function getBudgetExceededEvents(scopeId: string) {
  const rows = await db.execute<{ event_type: string; payload: Record<string, unknown> }>(
    drizzleSql`SELECT event_type, payload FROM ${eventsTable} WHERE event_type = 'BudgetExceeded' AND aggregate_id = ${scopeId} ORDER BY occurred_at DESC`,
  )
  return rows as unknown as Array<{ event_type: string; payload: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('budget enforcement — AC #3', () => {
  it('blocks third spawn when running cost exceeds hard cap', async () => {
    const projectId = uuidv7()
    const sprintId  = uuidv7()

    // Seed $0.10 hard cap for the sprint.
    await seedBudget('sprint', sprintId, 0.10)

    const costService = createCostService(db, eventStore, installId)
    const killCalls: number[] = []
    const enforcer = createCostEnforcer(db, eventStore, costService, (pid) => {
      killCalls.push(pid)
    })

    // Task 1: write $0.05 and check canSpawn — should allow.
    await writeFakeLedgerEntry(projectId, sprintId, 0.05)
    const result1 = await enforcer.canSpawn({
      projectId,
      sprintId,
      estimatedInputTokens:  1,  // negligible — $0.000003
      estimatedOutputTokens: 1,
    })
    expect(result1.allow).toBe(true)

    // Task 2: write another $0.05 (total $0.10) — estimated pushes over cap.
    await writeFakeLedgerEntry(projectId, sprintId, 0.05)
    const result2 = await enforcer.canSpawn({
      projectId,
      sprintId,
      estimatedInputTokens:  1,
      estimatedOutputTokens: 1,
    })
    // $0.10 running + any estimate > $0.10 cap → blocked
    expect(result2.allow).toBe(false)
    expect(result2.action).toBe('pause')

    // Verify BudgetExceeded event was written.
    const events = await getBudgetExceededEvents(sprintId)
    expect(events.length).toBeGreaterThanOrEqual(1)
    const ev = events[0]!
    expect(ev.payload['scope']).toBe('sprint')
    expect(ev.payload['scope_id']).toBe(sprintId)
    expect(Number(ev.payload['hard_cap_usd'])).toBe(0.10)
  })

  it('allows spawns while under cap and warns near threshold', async () => {
    const projectId = uuidv7()
    const sprintId  = uuidv7()

    // $1.00 cap, 80% soft = $0.80
    await seedBudget('sprint', sprintId, 1.00)

    const costService = createCostService(db, eventStore, installId)
    const enforcer = createCostEnforcer(db, eventStore, costService)

    // Write $0.85 — above soft, below hard
    await writeFakeLedgerEntry(projectId, sprintId, 0.85)

    const result = await enforcer.canSpawn({
      projectId,
      sprintId,
      estimatedInputTokens:  1,
      estimatedOutputTokens: 1,
    })

    expect(result.allow).toBe(true)
    expect(result.warn).toBe(true)
    expect(result.runningCostUsd).toBeCloseTo(0.85, 3)
  })
})
