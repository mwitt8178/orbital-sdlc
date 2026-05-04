/**
 * TestArtifactsPanel.test.tsx — Unit tests for TestArtifactsPanel utility logic.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * @testing-library/react is not installed in this package; the component's
 * rendering is validated manually / in e2e. This file tests the pure utility
 * functions extracted into testArtifactUtils.ts, covering every business rule
 * the component delegates to those helpers.
 */

import { describe, it, expect } from 'vitest'
import {
  countPending,
  allMerged,
  artifactCardColorClass,
  toggleExpanded,
  canAction,
  canGenerate,
  type TestArtifactSummary,
} from './testArtifactUtils.js'

// ---------------------------------------------------------------------------
// countPending
// ---------------------------------------------------------------------------

describe('countPending', () => {
  it('returns 0 for an empty list', () => {
    expect(countPending([])).toBe(0)
  })

  it('returns 0 when all artifacts are not pending', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'approved' },
      { id: 'a2', status: 'merged' },
    ]
    expect(countPending(artifacts)).toBe(0)
  })

  it('counts only pending artifacts', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'pending' },
      { id: 'a2', status: 'approved' },
      { id: 'a3', status: 'pending' },
      { id: 'a4', status: 'merged' },
    ]
    expect(countPending(artifacts)).toBe(2)
  })

  it('counts all when every artifact is pending', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'pending' },
      { id: 'a2', status: 'pending' },
      { id: 'a3', status: 'pending' },
    ]
    expect(countPending(artifacts)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// allMerged
// ---------------------------------------------------------------------------

describe('allMerged', () => {
  it('returns false for an empty list', () => {
    expect(allMerged([])).toBe(false)
  })

  it('returns false when any artifact is not merged', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'merged' },
      { id: 'a2', status: 'pending' },
    ]
    expect(allMerged(artifacts)).toBe(false)
  })

  it('returns false when any artifact is approved (not merged)', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'merged' },
      { id: 'a2', status: 'approved' },
    ]
    expect(allMerged(artifacts)).toBe(false)
  })

  it('returns true when every artifact is merged', () => {
    const artifacts: TestArtifactSummary[] = [
      { id: 'a1', status: 'merged' },
      { id: 'a2', status: 'merged' },
    ]
    expect(allMerged(artifacts)).toBe(true)
  })

  it('returns true for a single merged artifact', () => {
    expect(allMerged([{ id: 'a1', status: 'merged' }])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// artifactCardColorClass
// ---------------------------------------------------------------------------

describe('artifactCardColorClass', () => {
  it('returns amber classes for pending', () => {
    expect(artifactCardColorClass('pending')).toBe('border-amber-200 bg-amber-50/30')
  })

  it('returns emerald classes for merged', () => {
    expect(artifactCardColorClass('merged')).toBe('border-emerald-200 bg-emerald-50/30')
  })

  it('returns neutral classes for approved', () => {
    expect(artifactCardColorClass('approved')).toBe('border-slate-200 bg-white')
  })
})

// ---------------------------------------------------------------------------
// toggleExpanded
// ---------------------------------------------------------------------------

describe('toggleExpanded', () => {
  it('adds an id that is not in the set', () => {
    const result = toggleExpanded(new Set<string>(), 'abc')
    expect(result.has('abc')).toBe(true)
    expect(result.size).toBe(1)
  })

  it('removes an id that is already in the set', () => {
    const current = new Set(['abc', 'def'])
    const result = toggleExpanded(current, 'abc')
    expect(result.has('abc')).toBe(false)
    expect(result.has('def')).toBe(true)
  })

  it('returns a new Set (does not mutate the original)', () => {
    const current = new Set(['abc'])
    const result = toggleExpanded(current, 'abc')
    expect(result).not.toBe(current)
    // original is unchanged
    expect(current.has('abc')).toBe(true)
  })

  it('can toggle multiple ids independently', () => {
    let s = new Set<string>()
    s = toggleExpanded(s, 'x')
    s = toggleExpanded(s, 'y')
    expect(s.has('x')).toBe(true)
    expect(s.has('y')).toBe(true)
    s = toggleExpanded(s, 'x')
    expect(s.has('x')).toBe(false)
    expect(s.has('y')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// canAction
// ---------------------------------------------------------------------------

describe('canAction', () => {
  it('returns true for pending with a projectId', () => {
    expect(canAction('pending', 'proj-1')).toBe(true)
  })

  it('returns false for pending with null projectId', () => {
    expect(canAction('pending', null)).toBe(false)
  })

  it('returns false for approved even with a projectId', () => {
    expect(canAction('approved', 'proj-1')).toBe(false)
  })

  it('returns false for merged even with a projectId', () => {
    expect(canAction('merged', 'proj-1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canGenerate
// ---------------------------------------------------------------------------

describe('canGenerate', () => {
  it('returns true when projectId is present', () => {
    expect(canGenerate('proj-1')).toBe(true)
  })

  it('returns false when projectId is null', () => {
    expect(canGenerate(null)).toBe(false)
  })
})
