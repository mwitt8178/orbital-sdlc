/**
 * LiveCostMeter unit tests — pure logic layer.
 *
 * Note: @testing-library/react is not configured in this package.
 * These tests verify the pure display logic (fill % calculation, color
 * assignment, value clamping).
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from LiveCostMeter.tsx)
// ---------------------------------------------------------------------------

function clampPct(pctUsed: number): number {
  return Math.min(1, Math.max(0, pctUsed))
}

function fillWidthPct(pctUsed: number): number {
  return Math.round(clampPct(pctUsed) * 100)
}

function fillColor(pctUsed: number): string {
  const clamped = clampPct(pctUsed)
  if (clamped >= 0.9) return 'bg-red-500'
  if (clamped >= 0.7) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function costLabel(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveCostMeter — fillWidthPct', () => {
  it('returns 50 for pctUsed=0.5', () => {
    expect(fillWidthPct(0.5)).toBe(50)
  })

  it('returns 40 for pctUsed=0.4', () => {
    expect(fillWidthPct(0.4)).toBe(40)
  })

  it('clamps to 100 for pctUsed=1.5', () => {
    expect(fillWidthPct(1.5)).toBe(100)
  })

  it('clamps to 0 for pctUsed=-0.1', () => {
    expect(fillWidthPct(-0.1)).toBe(0)
  })

  it('returns 100 for pctUsed=1.0', () => {
    expect(fillWidthPct(1.0)).toBe(100)
  })
})

describe('LiveCostMeter — fillColor', () => {
  it('returns emerald-500 for pctUsed=0.5 (below 70%)', () => {
    expect(fillColor(0.5)).toBe('bg-emerald-500')
  })

  it('returns amber-500 for pctUsed=0.75 (70-90%)', () => {
    expect(fillColor(0.75)).toBe('bg-amber-500')
  })

  it('returns red-500 for pctUsed=0.9 (90%+)', () => {
    expect(fillColor(0.9)).toBe('bg-red-500')
  })

  it('returns red-500 for pctUsed=1.0', () => {
    expect(fillColor(1.0)).toBe('bg-red-500')
  })

  it('returns red-500 for pctUsed=1.5 (clamped to 1.0)', () => {
    expect(fillColor(1.5)).toBe('bg-red-500')
  })
})

describe('LiveCostMeter — costLabel', () => {
  it('formats $1.00', () => {
    expect(costLabel(1.0)).toBe('$1.00')
  })

  it('formats $2.50', () => {
    expect(costLabel(2.5)).toBe('$2.50')
  })

  it('formats $0.01', () => {
    expect(costLabel(0.01)).toBe('$0.01')
  })
})
