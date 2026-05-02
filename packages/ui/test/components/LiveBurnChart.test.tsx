/**
 * LiveBurnChart unit tests — pure display logic.
 *
 * Tests scale helpers and data-boundary conditions without a DOM renderer.
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from LiveBurnChart.tsx)
// ---------------------------------------------------------------------------

interface BurnPoint {
  ts: number
  costUsd: number
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function xScale(ts: number, minTs: number, maxTs: number, chartW: number, padLeft: number) {
  return padLeft + ((ts - minTs) / (maxTs - minTs || 1)) * chartW
}

function yScale(v: number, maxCost: number, chartH: number, padTop: number) {
  return padTop + chartH - (v / maxCost) * chartH
}

function hasData(points: BurnPoint[]) {
  return points.length >= 2
}

function computeMaxCost(points: BurnPoint[], hardCapUsd: number | null) {
  return Math.max(...points.map((p) => p.costUsd), hardCapUsd ?? 0, 0.001)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveBurnChart — hasData', () => {
  it('returns false for empty array', () => {
    expect(hasData([])).toBe(false)
  })

  it('returns false for single point', () => {
    expect(hasData([{ ts: 1, costUsd: 1 }])).toBe(false)
  })

  it('returns true for two or more points', () => {
    expect(hasData([{ ts: 1, costUsd: 1 }, { ts: 2, costUsd: 2 }])).toBe(true)
  })
})

describe('LiveBurnChart — computeMaxCost', () => {
  it('returns max of points and hard cap', () => {
    const pts = [{ ts: 0, costUsd: 5 }, { ts: 1, costUsd: 3 }]
    expect(computeMaxCost(pts, 10)).toBe(10)
  })

  it('returns max of points when hard cap is null', () => {
    const pts = [{ ts: 0, costUsd: 7 }, { ts: 1, costUsd: 5 }]
    expect(computeMaxCost(pts, null)).toBe(7)
  })

  it('returns minimum 0.001 when all costs are 0 and no cap', () => {
    const pts = [{ ts: 0, costUsd: 0 }, { ts: 1, costUsd: 0 }]
    expect(computeMaxCost(pts, null)).toBe(0.001)
  })
})

describe('LiveBurnChart — xScale', () => {
  it('maps minTs to padLeft', () => {
    const x = xScale(0, 0, 100, 500, 44)
    expect(x).toBe(44)
  })

  it('maps maxTs to padLeft + chartW', () => {
    const x = xScale(100, 0, 100, 500, 44)
    expect(x).toBe(544)
  })

  it('maps midpoint to padLeft + chartW/2', () => {
    const x = xScale(50, 0, 100, 500, 44)
    expect(x).toBe(44 + 250)
  })

  it('handles degenerate case (minTs === maxTs) without NaN', () => {
    const x = xScale(5, 5, 5, 500, 44)
    expect(Number.isFinite(x)).toBe(true)
  })
})

describe('LiveBurnChart — yScale', () => {
  it('maps 0 cost to bottom of chart', () => {
    // padTop=12, chartH=84, maxCost=10
    const y = yScale(0, 10, 84, 12)
    expect(y).toBe(12 + 84) // bottom
  })

  it('maps maxCost to padTop (top of chart)', () => {
    const y = yScale(10, 10, 84, 12)
    expect(y).toBe(12) // top
  })

  it('maps half maxCost to middle', () => {
    const y = yScale(5, 10, 84, 12)
    expect(y).toBe(12 + 42) // middle
  })
})

describe('LiveBurnChart — clamp', () => {
  it('clamps below min', () => {
    expect(clamp(-5, 0, 100)).toBe(0)
  })

  it('clamps above max', () => {
    expect(clamp(150, 0, 100)).toBe(100)
  })

  it('passes through in-range value', () => {
    expect(clamp(50, 0, 100)).toBe(50)
  })
})
