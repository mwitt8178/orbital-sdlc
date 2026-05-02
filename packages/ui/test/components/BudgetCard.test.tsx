/**
 * BudgetCard unit tests — pure display/calculation logic.
 *
 * Tests percentage calculation, color thresholds, and status text
 * without a DOM renderer.
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from BudgetCard.tsx)
// ---------------------------------------------------------------------------

function computePct(runningCostUsd: number, hardCapUsd: number | null): number {
  if (!hardCapUsd || hardCapUsd <= 0) return 0
  return Math.min(1, Math.max(0, runningCostUsd / hardCapUsd))
}

function fillColor(pct: number): string {
  if (pct >= 1.0) return 'bg-red-500'
  if (pct >= 0.8) return 'bg-amber-500'
  if (pct >= 0.5) return 'bg-yellow-400'
  return 'bg-emerald-500'
}

function statusText(pct: number): string {
  if (pct >= 1.0) return 'Over cap'
  if (pct >= 0.8) return 'Approaching cap'
  return 'On track'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BudgetCard — computePct', () => {
  it('returns 0 when hardCapUsd is null', () => {
    expect(computePct(5, null)).toBe(0)
  })

  it('returns 0 when hardCapUsd is 0', () => {
    expect(computePct(5, 0)).toBe(0)
  })

  it('returns 0.5 when at half cap', () => {
    expect(computePct(5, 10)).toBe(0.5)
  })

  it('returns 1.0 at exact cap', () => {
    expect(computePct(10, 10)).toBe(1.0)
  })

  it('clamps to 1.0 when over cap', () => {
    expect(computePct(15, 10)).toBe(1.0)
  })

  it('clamps to 0 for negative running cost', () => {
    expect(computePct(-1, 10)).toBe(0)
  })
})

describe('BudgetCard — fillColor', () => {
  it('emerald when below 50%', () => {
    expect(fillColor(0.3)).toBe('bg-emerald-500')
  })

  it('yellow when 50-80%', () => {
    expect(fillColor(0.65)).toBe('bg-yellow-400')
  })

  it('amber when 80-100%', () => {
    expect(fillColor(0.85)).toBe('bg-amber-500')
  })

  it('red when at 100%', () => {
    expect(fillColor(1.0)).toBe('bg-red-500')
  })

  it('red when over 100%', () => {
    expect(fillColor(1.2)).toBe('bg-red-500')
  })
})

describe('BudgetCard — statusText', () => {
  it('On track when below 80%', () => {
    expect(statusText(0.5)).toBe('On track')
  })

  it('Approaching cap when 80-99%', () => {
    expect(statusText(0.9)).toBe('Approaching cap')
  })

  it('Over cap when at 100%', () => {
    expect(statusText(1.0)).toBe('Over cap')
  })

  it('Over cap when above 100%', () => {
    expect(statusText(1.5)).toBe('Over cap')
  })
})
