/**
 * Unit tests for cost/enforcer.ts
 *
 * Uses stub implementations of CostService and EventStore.
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CostEnforcer } from '../../../src/cost/enforcer.js'
import type { CostService } from '../../../src/cost/service.js'
import type { EventStore } from '../../../src/events/store.js'
import type { CostBudget } from '../../../src/cost/types.js'
import type { DB } from '../../../src/db/client.js'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeBudget(overrides: Partial<CostBudget> = {}): CostBudget {
  return {
    budgetId:         'budget-1',
    scope:            'sprint',
    scopeId:          'sprint-1',
    hardCapUsd:       1.00,
    softThresholdPct: 80,
    onSoft:           'alert',
    onHard:           'pause',
    active:           true,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString(),
    ...overrides,
  }
}

function makeCostServiceStub(runningCost: number, budget: CostBudget | null): CostService {
  return {
    appendLedger: vi.fn().mockResolvedValue({ entryId: 'e1', costUsd: 0.01 }),
    getBudget:    vi.fn().mockResolvedValue(budget),
    setBudget:    vi.fn(),
    summarize:    vi.fn(),
    getRunningCost: vi.fn().mockResolvedValue(runningCost),
  } as unknown as CostService
}

function makeEventStore(): EventStore {
  return {
    append:     vi.fn().mockResolvedValue({ event_id: 'ev1' }),
    query:      vi.fn().mockResolvedValue({ events: [], next_cursor: null }),
    subscribe:  vi.fn().mockReturnValue(() => {}),
  } as unknown as EventStore
}

function makeDb(): DB {
  return {
    execute: vi.fn().mockResolvedValue([]),
    select:  vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
    update:  vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  } as unknown as DB
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostEnforcer.canSpawn', () => {
  it('allows spawn when no budget configured', async () => {
    const svc = makeCostServiceStub(0, null)
    const enforcer = new CostEnforcer(makeDb(), makeEventStore(), svc)

    const result = await enforcer.canSpawn({ projectId: 'proj-1', sprintId: 'sprint-1' })
    expect(result.allow).toBe(true)
    expect(result.hardCapUsd).toBe(null)
  })

  it('allows spawn when running + estimated < hard cap', async () => {
    const budget = makeBudget({ hardCapUsd: 1.00 })
    const svc = makeCostServiceStub(0.01, budget) // $0.01 running
    const enforcer = new CostEnforcer(makeDb(), makeEventStore(), svc)

    const result = await enforcer.canSpawn({ projectId: 'proj-1', sprintId: 'sprint-1' })
    expect(result.allow).toBe(true)
    expect(result.hardCapUsd).toBe(1.00)
  })

  it('blocks spawn when running + estimated > hard cap', async () => {
    // $0.99 running + ~$0.03 estimated (10k input + 2k output at Sonnet rates) > $1.00
    const budget = makeBudget({ hardCapUsd: 0.99 })
    const svc = makeCostServiceStub(0.99, budget)
    const enforcer = new CostEnforcer(makeDb(), makeEventStore(), svc)

    const result = await enforcer.canSpawn({ projectId: 'proj-1', sprintId: 'sprint-1' })
    expect(result.allow).toBe(false)
    expect(result.action).toBe('pause')
  })

  it('warns but allows when approaching soft threshold', async () => {
    // $0.82 running with $1.00 cap and 80% soft = warn at $0.80
    const budget = makeBudget({ hardCapUsd: 1.00, softThresholdPct: 80 })
    const svc = makeCostServiceStub(0.82, budget)
    const enforcer = new CostEnforcer(makeDb(), makeEventStore(), svc)

    const result = await enforcer.canSpawn({
      projectId: 'proj-1',
      sprintId: 'sprint-1',
      estimatedInputTokens:  1,    // tiny — won't push over hard cap
      estimatedOutputTokens: 1,
    })
    expect(result.allow).toBe(true)
    expect(result.warn).toBe(true)
  })

  it('emits BudgetExceeded event when spawn is blocked', async () => {
    const budget = makeBudget({ hardCapUsd: 0.01 })
    const svc = makeCostServiceStub(0.99, budget)
    const es = makeEventStore()
    const enforcer = new CostEnforcer(makeDb(), es, svc)

    await enforcer.canSpawn({ projectId: 'proj-1', sprintId: 'sprint-1' })

    const appendCalls = (es.append as ReturnType<typeof vi.fn>).mock.calls
    const budgetExceeded = appendCalls.find(
      ([ev]: [{ event_type: string }]) => ev.event_type === 'BudgetExceeded',
    )
    expect(budgetExceeded).toBeDefined()
  })

  it('uses project-scope budget when no sprint budget is configured', async () => {
    const projectBudget = makeBudget({ scope: 'project', scopeId: 'proj-1', hardCapUsd: 2.00 })
    const svc: CostService = {
      appendLedger:   vi.fn(),
      getBudget:      vi.fn().mockImplementation((scope: string) => {
        if (scope === 'sprint') return Promise.resolve(null)
        return Promise.resolve(projectBudget)
      }),
      setBudget:      vi.fn(),
      summarize:      vi.fn(),
      getRunningCost: vi.fn().mockResolvedValue(0.10),
    } as unknown as CostService

    const enforcer = new CostEnforcer(makeDb(), makeEventStore(), svc)
    const result = await enforcer.canSpawn({ projectId: 'proj-1', sprintId: 'sprint-1' })
    expect(result.hardCapUsd).toBe(2.00)
  })
})

describe('CostEnforcer.killAll', () => {
  it('sends SIGTERM to workers and emits KillSwitchTripped events', async () => {
    const killed: number[] = []
    const mockKillFn = vi.fn((pid: number) => { killed.push(pid) })

    const db = {
      execute: vi.fn().mockResolvedValue([
        { worker_id: 'w1', pid: 12345, status: 'active' },
        { worker_id: 'w2', pid: 12346, status: 'active' },
      ]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as DB

    const es = makeEventStore()
    const svc = makeCostServiceStub(0, null)
    const enforcer = new CostEnforcer(db, es, svc, mockKillFn)

    const result = await enforcer.killAll('sprint', 'sprint-1', 'test', 'operator-1')

    expect(result.killedWorkerIds).toEqual(['w1', 'w2'])
    expect(result.signalsSent).toBe(2)
    expect(killed).toEqual([12345, 12346])

    // Verify KillSwitchTripped was emitted per worker
    const appendCalls = (es.append as ReturnType<typeof vi.fn>).mock.calls
    const killEvents = appendCalls.filter(
      ([ev]: [{ event_type: string }]) => ev.event_type === 'KillSwitchTripped',
    )
    expect(killEvents.length).toBe(2)
  })

  it('handles workers without pid gracefully', async () => {
    const mockKillFn = vi.fn()
    const db = {
      execute: vi.fn().mockResolvedValue([
        { worker_id: 'w1', pid: null, status: 'active' },
      ]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as DB

    const enforcer = new CostEnforcer(db, makeEventStore(), makeCostServiceStub(0, null), mockKillFn)
    const result = await enforcer.killAll('sprint', 'sprint-1', 'test', 'op')

    expect(result.killedWorkerIds).toEqual(['w1'])
    expect(result.signalsSent).toBe(0)
    expect(mockKillFn).not.toHaveBeenCalled()
  })
})
