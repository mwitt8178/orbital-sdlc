/**
 * Integration tests for RoutingEngine and CostAccounting — real Postgres.
 *
 * Done criteria:
 * - selectModel() writes routing_decisions row AND emits RoutingDecisionMade event
 * - CostAccounting.report() writes cost_accounting row AND emits CostReported event
 * - BudgetWarning fires at 80% utilization
 * - BudgetExceeded fires at 100% utilization
 * - Idempotent cost reporting (same session+turn → no duplicate row)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createRoutingEngine, buildDefaultCatalog } from '../../../src/routing/engine.js'
import { createCostAccounting } from '../../../src/routing/cost.js'
import { ensureActivePolicyInDb, BUILT_IN_DEFAULT_POLICY } from '../../../src/routing/policy.js'
import { routingDecisions, costAccounting, budgetCaps } from '../../../src/db/schema/routing.js'
import type { RouterInput } from '../../../src/routing/types.js'
import type { SprintId, TaskId } from '@orbital/types'

const eventStore = createEventStore(db, sql)
const catalog = buildDefaultCatalog()
let policyVersion = 1

beforeAll(async () => {
  policyVersion = await ensureActivePolicyInDb(db, BUILT_IN_DEFAULT_POLICY)
})

function makeRoutingEngine() {
  return createRoutingEngine(db, eventStore, BUILT_IN_DEFAULT_POLICY, catalog, policyVersion)
}

function makeRoutingInput(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    task_id: uuidv7(),
    persona_id: 'sr-dev',
    risk_class: 'standard',
    retry_depth: 0,
    trace_id: uuidv7(),
    ...overrides,
  }
}

describe('RoutingEngine.selectModel — integration', () => {
  it('returns a RoutingDecision with correct model for standard risk', async () => {
    const engine = makeRoutingEngine()
    const input = makeRoutingInput({ persona_id: 'sr-dev', risk_class: 'standard' })
    const decision = await engine.selectModel(input)

    expect(decision.model).toBe('claude-sonnet-4-6')
    expect(decision.decision_id).toBeTruthy()
    expect(decision.policy_version).toBe(policyVersion)
  })

  it('writes a routing_decisions row to the DB', async () => {
    const engine = makeRoutingEngine()
    const taskId = uuidv7()
    const input = makeRoutingInput({ task_id: taskId })
    const decision = await engine.selectModel(input)

    const rows = await db
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.decisionId, decision.decision_id))

    expect(rows.length).toBe(1)
    expect(rows[0]!.taskId).toBe(taskId)
    expect(rows[0]!.model).toBe(decision.model)
  })

  it('emits RoutingDecisionMade event via EventStore', async () => {
    const engine = makeRoutingEngine()
    const taskId = uuidv7()
    const traceId = uuidv7()
    const input = makeRoutingInput({ task_id: taskId, trace_id: traceId })
    const decision = await engine.selectModel(input)

    const events = await eventStore.query({
      event_type: 'RoutingDecisionMade',
      aggregate_id: taskId,
      limit: 10,
    })

    expect(events.items.length).toBeGreaterThanOrEqual(1)
    const evt = events.items[0]!
    expect(evt.payload['decision_id']).toBe(decision.decision_id)
    expect(evt.payload['model']).toBe(decision.model)
    expect(evt.trace_id).toBe(traceId)
  })

  it('selects opus for high-risk task', async () => {
    const engine = makeRoutingEngine()
    const input = makeRoutingInput({ risk_class: 'high' })
    const decision = await engine.selectModel(input)
    expect(decision.model).toBe('claude-opus-4-6')
  })

  it('selects haiku for low-risk jr-dev task', async () => {
    const engine = makeRoutingEngine()
    const input = makeRoutingInput({ persona_id: 'jr-dev', risk_class: 'low' })
    const decision = await engine.selectModel(input)
    expect(decision.model).toBe('claude-haiku-4-5')
  })
})

describe('CostAccounting.report — integration', () => {
  it('writes a cost_accounting row and emits CostReported event', async () => {
    const costSvc = createCostAccounting(db, eventStore)
    const taskId = uuidv7() as TaskId
    const sessionId = uuidv7()
    const sprintId = uuidv7() as SprintId
    const traceId = uuidv7()

    const result = await costSvc.report({
      taskId,
      sessionId,
      sprintId,
      model: 'claude-sonnet-4-6',
      turnIndex: 0,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      },
      traceId,
    })

    expect(result.costId).toBeTruthy()
    expect(result.costUsdMicros).toBeGreaterThan(0)

    // Verify DB row
    const rows = await db
      .select()
      .from(costAccounting)
      .where(eq(costAccounting.costId, result.costId))

    expect(rows.length).toBe(1)
    expect(rows[0]!.taskId).toBe(taskId)
    expect(rows[0]!.model).toBe('claude-sonnet-4-6')
    expect(rows[0]!.inputTokens).toBe(1000)
    expect(rows[0]!.cacheReadTokens).toBe(200)

    // Verify CostReported event
    const events = await eventStore.query({
      event_type: 'CostReported',
      aggregate_id: taskId,
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
    expect(events.items[0]!.payload['cost_id']).toBe(result.costId)
  })

  it('is idempotent: same (sessionId, turnIndex) does not double-count', async () => {
    const costSvc = createCostAccounting(db, eventStore)
    const taskId = uuidv7() as TaskId
    const sessionId = uuidv7()
    const sprintId = uuidv7() as SprintId
    const traceId = uuidv7()

    const params = {
      taskId,
      sessionId,
      sprintId,
      model: 'claude-haiku-4-5' as const,
      turnIndex: 0,
      usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      traceId,
    }

    const first = await costSvc.report(params)
    const second = await costSvc.report(params) // same turn, should be idempotent

    expect(second.costId).toBe(first.costId)
    expect(second.costUsdMicros).toBe(first.costUsdMicros)

    // Only 1 row in DB
    const rows = await db
      .select()
      .from(costAccounting)
      .where(
        and(
          eq(costAccounting.sessionId, sessionId),
          eq(costAccounting.turnIndex, 0),
        ),
      )
    expect(rows.length).toBe(1)
  })

  it('getSprintTotal() aggregates cost across turns', async () => {
    const costSvc = createCostAccounting(db, eventStore)
    const taskId = uuidv7() as TaskId
    const sessionId = uuidv7()
    const sprintId = uuidv7() as SprintId
    const traceId = uuidv7()

    await costSvc.report({ taskId, sessionId, sprintId, model: 'claude-haiku-4-5', turnIndex: 0, usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, traceId })
    await costSvc.report({ taskId, sessionId, sprintId, model: 'claude-haiku-4-5', turnIndex: 1, usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, traceId })

    const total = await costSvc.getSprintTotal(sprintId)
    expect(total.turn_count).toBe(2)
    expect(total.input_tokens).toBe(2000)
    expect(total.total_usd_micros).toBeGreaterThan(0)
  })
})

describe('CostAccounting — budget enforcement integration', () => {
  it('emits BudgetWarning at 80% sprint budget utilization', async () => {
    const costSvc = createCostAccounting(db, eventStore)
    const sprintId = uuidv7() as SprintId
    const traceId = uuidv7()

    // Create a budget cap of 1000 micros (warning at 80% = 800 micros)
    const capId = uuidv7()
    await db.insert(budgetCaps).values({
      capId,
      scope: 'sprint',
      scopeKey: sprintId,
      capUsdMicros: 1000,
      warningThresholdPct: 80,
      state: 'active',
    })

    // Report cost that brings us to ~85% (850 micros)
    // haiku: $0.80/Mtok input; 850_000_000 / 800_000 Mtok_per_dollar ≈ 1_062_500 tokens
    // Simpler: use sonnet; $3/Mtok; 850 micros = 850 / 3_000_000 Mtok = 283 tokens
    // Let's just use input_tokens that produce > 800 but < 1000 micros
    // sonnet: (N/1_000_000) * 3_000_000 = N*3; N=300 → 900 micros
    const result = await costSvc.report({
      taskId: uuidv7() as TaskId,
      sessionId: uuidv7(),
      sprintId,
      model: 'claude-sonnet-4-6',
      turnIndex: 0,
      usage: { input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      traceId,
    })

    // Should be warned (900 >= 800)
    expect(result.budgetState).toBe('warned')

    // BudgetWarning event should exist
    const events = await eventStore.query({
      event_type: 'BudgetWarning',
      aggregate_id: sprintId,
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('emits BudgetExceeded at 100% sprint budget utilization', async () => {
    const costSvc = createCostAccounting(db, eventStore)
    const sprintId = uuidv7() as SprintId
    const traceId = uuidv7()

    // Create a tiny budget cap of 1 micro
    const capId = uuidv7()
    await db.insert(budgetCaps).values({
      capId,
      scope: 'sprint',
      scopeKey: sprintId,
      capUsdMicros: 1, // 1 micro — any spend exceeds this
      warningThresholdPct: 80,
      state: 'warned', // Skip warning, go straight to exceeded check
    })

    const result = await costSvc.report({
      taskId: uuidv7() as TaskId,
      sessionId: uuidv7(),
      sprintId,
      model: 'claude-haiku-4-5',
      turnIndex: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      traceId,
    })

    // Budget exceeded
    expect(result.budgetState).toBe('exceeded')

    const events = await eventStore.query({
      event_type: 'BudgetExceeded',
      aggregate_id: sprintId,
      limit: 5,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  }, 30_000)
})
