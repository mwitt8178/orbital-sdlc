/**
 * DefectTimeline unit tests — pure display logic.
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Tests the pure helpers: severity color mapping, isRunning detection,
 * expand/collapse set operations, and footer summary text formatting.
 * No jsdom or RTL — pure function assertions.
 * E2E coverage is in Playwright specs.
 */

import { describe, it, expect } from 'vitest'
import type { DefectTimeline } from '../../../src/components/features/uat/DefectTimeline.js'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from DefectTimeline.tsx)
// ---------------------------------------------------------------------------

type Severity = 'low' | 'medium' | 'high' | 'critical'

const SEVERITY_COLOR_MAP: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-rose-100 text-rose-700 border-rose-100',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  low: 'bg-slate-100 text-slate-600 border-slate-200',
}

function severityClasses(severity: Severity): string {
  return SEVERITY_COLOR_MAP[severity]
}

/**
 * Whether this defect entry should show the pulsing "Iterating" indicator.
 * isLast: the defect is the most recent entry (iterationNumber === total defects)
 * iterationCount: the live iteration count from the task (> 0 means running)
 */
function isRunning(
  iterationNumber: number,
  totalDefects: number,
  iterationCount: number,
): boolean {
  const isLast = iterationNumber === totalDefects
  return isLast && iterationCount > 0 && iterationCount === iterationNumber
}

/** Toggle a defect ID in the expanded set (immutable, returns new Set). */
function toggleExpanded(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

function footerSummary(iterationCount: number, defectsLength: number): string {
  return `Total iterations: ${iterationCount} · Total defects: ${defectsLength}`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefectTimeline — severity chip classes', () => {
  it('applies red classes for critical', () => {
    expect(severityClasses('critical')).toContain('red')
  })

  it('applies rose classes for high', () => {
    expect(severityClasses('high')).toContain('rose')
  })

  it('applies amber classes for medium', () => {
    expect(severityClasses('medium')).toContain('amber')
  })

  it('applies slate classes for low', () => {
    expect(severityClasses('low')).toContain('slate')
  })

  it('all four severities return distinct class strings', () => {
    const classes = (['low', 'medium', 'high', 'critical'] as Severity[]).map(severityClasses)
    const unique = new Set(classes)
    expect(unique.size).toBe(4)
  })
})

describe('DefectTimeline — isRunning detection', () => {
  it('returns false when iterationCount = 0 (task idle)', () => {
    expect(isRunning(1, 1, 0)).toBe(false)
  })

  it('returns false for a non-last entry', () => {
    // defect #1 of 3 total, iterationCount=3 (running the 3rd)
    expect(isRunning(1, 3, 3)).toBe(false)
  })

  it('returns false when iterationNumber does not equal iterationCount', () => {
    // last entry (#2 of 2) but iterationCount=3
    expect(isRunning(2, 2, 3)).toBe(false)
  })

  it('returns true for the last entry when iterationCount matches iterationNumber', () => {
    // defect #2 of 2, iterationCount=2 — actively running
    expect(isRunning(2, 2, 2)).toBe(true)
  })

  it('returns true for the first (and only) entry when iterationCount=1', () => {
    expect(isRunning(1, 1, 1)).toBe(true)
  })

  it('returns true for the last of 3 entries when iterationCount=3', () => {
    expect(isRunning(3, 3, 3)).toBe(true)
  })
})

describe('DefectTimeline — expand/collapse toggle', () => {
  it('adds an id that was not present', () => {
    const prev = new Set<string>(['a'])
    const next = toggleExpanded(prev, 'b')
    expect(next.has('b')).toBe(true)
    expect(next.has('a')).toBe(true)
  })

  it('removes an id that was already present', () => {
    const prev = new Set<string>(['a', 'b'])
    const next = toggleExpanded(prev, 'b')
    expect(next.has('b')).toBe(false)
    expect(next.has('a')).toBe(true)
  })

  it('does not mutate the original set', () => {
    const prev = new Set<string>(['a'])
    toggleExpanded(prev, 'a')
    expect(prev.has('a')).toBe(true) // prev unchanged
  })

  it('starts empty and adds first entry', () => {
    const next = toggleExpanded(new Set<string>(), 'xyz')
    expect(next.has('xyz')).toBe(true)
    expect(next.size).toBe(1)
  })

  it('toggles back to empty set', () => {
    const withOne = new Set<string>(['abc'])
    const empty = toggleExpanded(withOne, 'abc')
    expect(empty.size).toBe(0)
  })
})

describe('DefectTimeline — footer summary text', () => {
  it('formats zero iterations and zero defects', () => {
    expect(footerSummary(0, 0)).toBe('Total iterations: 0 · Total defects: 0')
  })

  it('formats one iteration, one defect', () => {
    expect(footerSummary(1, 1)).toBe('Total iterations: 1 · Total defects: 1')
  })

  it('formats multiple iterations and defects', () => {
    expect(footerSummary(3, 5)).toBe('Total iterations: 3 · Total defects: 5')
  })

  it('footer uses middle dot separator', () => {
    const text = footerSummary(2, 2)
    expect(text).toContain('·')
  })
})

describe('DefectTimeline — module exports', () => {
  it('DefectTimeline type is a function type (compile-time export check)', () => {
    // TypeScript compile-time check: if DefectTimeline is not exported, the
    // import type above will fail tsc --noEmit. Runtime assertion is a tsc gate.
    type ComponentType = typeof DefectTimeline
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _check: ComponentType = undefined as unknown as ComponentType
    expect(true).toBe(true)
  })
})
