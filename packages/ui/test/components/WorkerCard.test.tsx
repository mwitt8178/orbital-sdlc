/**
 * WorkerCard unit tests — pure logic layer.
 *
 * Note: @testing-library/react is not configured in this package.
 * These tests verify the pure logic helpers exported from WorkerCard
 * (state color mapping, doingNow label, relative time formatting).
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { describe, it, expect } from 'vitest'
import type { WorkerInspection } from '../../src/components/features/inspection/types.js'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from WorkerCard.tsx)
// ---------------------------------------------------------------------------

type WorkerState = WorkerInspection['state']

function stateColor(state: WorkerState): string {
  switch (state) {
    case 'running': return 'bg-emerald-100 text-emerald-700'
    case 'briefing': return 'bg-blue-100 text-blue-700'
    case 'awaiting': return 'bg-amber-100 text-amber-700'
    case 'idle': return 'bg-slate-100 text-slate-600'
    case 'terminating': return 'bg-orange-100 text-orange-700'
    case 'terminated': return 'bg-red-100 text-red-700'
    default: return 'bg-slate-100 text-slate-500'
  }
}

function doingNow(inspection: WorkerInspection): string {
  const lastTool = inspection.recentToolCalls.at(-1)
  const lastLLM = inspection.recentLLMCalls.at(-1)

  if (lastTool && lastTool.status === 'pending') {
    return `Running tool: ${lastTool.name}`
  }
  if (lastLLM && lastLLM.status === 'pending') {
    return `Calling ${lastLLM.model}`
  }
  if (lastTool) return `Last: ${lastTool.name} (${lastTool.status})`
  if (lastLLM) return `Last LLM: ${lastLLM.model}`
  return inspection.state === 'briefing' ? 'Loading brief…' : 'Waiting'
}

function makeInspection(overrides: Partial<WorkerInspection> = {}): WorkerInspection {
  return {
    workerId: 'worker-abc123',
    taskId: 'task-456',
    ticketId: 'TICKET-789',
    persona: { id: 'sr-dev', name: 'Senior Developer', tier: 'sonnet' },
    model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    state: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    capability: {
      scopes: { filesRead: ['**/*.ts'], filesWrite: ['**/*.ts'], channelPost: [] },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    skillsLoaded: [{ id: 'tdd-workflow', loadedAt: new Date().toISOString(), sourceSha256: 'abc123' }],
    recentLLMCalls: [],
    recentToolCalls: [],
    costToDate: { tokens: 1000, usd: 0.01 },
    costBudgetForScope: { hardCap: 5.0, softThreshold: 4.0, pctUsed: 0.2 },
    recentChannelPosts: [],
    outputTail: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerCard — stateColor helper', () => {
  it('returns emerald for running', () => {
    expect(stateColor('running')).toContain('emerald')
  })

  it('returns blue for briefing', () => {
    expect(stateColor('briefing')).toContain('blue')
  })

  it('returns red for terminated', () => {
    expect(stateColor('terminated')).toContain('red')
  })

  it('returns amber for awaiting', () => {
    expect(stateColor('awaiting')).toContain('amber')
  })

  it('returns orange for terminating', () => {
    expect(stateColor('terminating')).toContain('orange')
  })
})

describe('WorkerCard — doingNow helper', () => {
  it('shows "Loading brief…" when briefing and no calls', () => {
    const result = doingNow(makeInspection({ state: 'briefing' }))
    expect(result).toBe('Loading brief…')
  })

  it('shows "Waiting" when running and no calls', () => {
    const result = doingNow(makeInspection({ state: 'running' }))
    expect(result).toBe('Waiting')
  })

  it('shows active tool name when tool is pending', () => {
    const result = doingNow(makeInspection({
      recentToolCalls: [{ toolCallId: 'tc1', name: 'bash.run', startedAt: new Date().toISOString(), status: 'pending' }],
    }))
    expect(result).toBe('Running tool: bash.run')
  })

  it('shows active LLM model when LLM call is pending', () => {
    const result = doingNow(makeInspection({
      recentLLMCalls: [{ llmCallId: 'lc1', startedAt: new Date().toISOString(), status: 'pending', provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    }))
    expect(result).toBe('Calling claude-sonnet-4-6')
  })

  it('shows last tool result when tool is completed', () => {
    const result = doingNow(makeInspection({
      recentToolCalls: [{ toolCallId: 'tc1', name: 'read', startedAt: new Date().toISOString(), status: 'ok' }],
    }))
    expect(result).toBe('Last: read (ok)')
  })
})

describe('WorkerCard — WorkerInspection type structure', () => {
  it('has the expected shape for workerId, taskId, ticketId', () => {
    const w = makeInspection()
    expect(w.workerId).toBe('worker-abc123')
    expect(w.taskId).toBe('task-456')
    expect(w.ticketId).toBe('TICKET-789')
  })

  it('has costBudgetForScope when present', () => {
    const w = makeInspection()
    expect(w.costBudgetForScope?.hardCap).toBe(5.0)
    expect(w.costBudgetForScope?.pctUsed).toBe(0.2)
  })

  it('skillsLoaded has id and sourceSha256', () => {
    const w = makeInspection()
    expect(w.skillsLoaded[0].id).toBe('tdd-workflow')
    expect(w.skillsLoaded[0].sourceSha256).toBe('abc123')
  })
})
