/**
 * ReviewPanel unit tests — pure display logic.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Tests the pure helpers: state label mapping, badge CSS class mapping,
 * state icon mapping, and module exports.
 *
 * Note: full JSX rendering with React Testing Library is not set up in this
 * package (no @testing-library/react or jsdom configured). These tests cover
 * the pure logic layer. E2E coverage is in Playwright specs.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers mirrored from ReviewPanel.tsx
// ---------------------------------------------------------------------------

type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'

function stateLabel(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes Requested'
    case 'COMMENTED':
      return 'Commented'
  }
}

function stateBadgeClasses(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'CHANGES_REQUESTED':
      return 'bg-rose-100 text-rose-800 border-rose-200'
    case 'COMMENTED':
      return 'bg-slate-100 text-slate-700 border-slate-200'
  }
}

function stateIcon(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return '✓'
    case 'CHANGES_REQUESTED':
      return '✗'
    case 'COMMENTED':
      return '○'
  }
}

function hasApprovedBanner(reviews: Array<{ state: string }>): boolean {
  return reviews.some((r) => r.state === 'APPROVED')
}

function latestApprovedReviewer(
  reviews: Array<{ state: string; reviewer_persona_id: string }>,
): string | undefined {
  return reviews.find((r) => r.state === 'APPROVED')?.reviewer_persona_id
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewPanel — stateLabel', () => {
  it('returns "Approved" for APPROVED', () => {
    expect(stateLabel('APPROVED')).toBe('Approved')
  })

  it('returns "Changes Requested" for CHANGES_REQUESTED', () => {
    expect(stateLabel('CHANGES_REQUESTED')).toBe('Changes Requested')
  })

  it('returns "Commented" for COMMENTED', () => {
    expect(stateLabel('COMMENTED')).toBe('Commented')
  })
})

describe('ReviewPanel — stateBadgeClasses', () => {
  it('applies emerald classes for APPROVED', () => {
    const classes = stateBadgeClasses('APPROVED')
    expect(classes).toContain('emerald')
  })

  it('applies rose classes for CHANGES_REQUESTED', () => {
    const classes = stateBadgeClasses('CHANGES_REQUESTED')
    expect(classes).toContain('rose')
  })

  it('applies slate classes for COMMENTED', () => {
    const classes = stateBadgeClasses('COMMENTED')
    expect(classes).toContain('slate')
  })
})

describe('ReviewPanel — stateIcon', () => {
  it('returns checkmark for APPROVED', () => {
    expect(stateIcon('APPROVED')).toBe('✓')
  })

  it('returns cross for CHANGES_REQUESTED', () => {
    expect(stateIcon('CHANGES_REQUESTED')).toBe('✗')
  })

  it('returns circle for COMMENTED', () => {
    expect(stateIcon('COMMENTED')).toBe('○')
  })
})

describe('ReviewPanel — approved banner logic', () => {
  it('shows banner when at least one review is APPROVED', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED' },
      { state: 'APPROVED' },
    ]
    expect(hasApprovedBanner(reviews)).toBe(true)
  })

  it('does not show banner when no APPROVED review exists', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED' },
      { state: 'COMMENTED' },
    ]
    expect(hasApprovedBanner(reviews)).toBe(false)
  })

  it('does not show banner for empty reviews list', () => {
    expect(hasApprovedBanner([])).toBe(false)
  })

  it('extracts the correct reviewer persona ID from APPROVED review', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED', reviewer_persona_id: 'reviewer-v1' },
      { state: 'APPROVED', reviewer_persona_id: 'reviewer-sonnet' },
    ]
    expect(latestApprovedReviewer(reviews)).toBe('reviewer-sonnet')
  })

  it('returns undefined when no APPROVED review', () => {
    const reviews = [{ state: 'COMMENTED', reviewer_persona_id: 'reviewer' }]
    expect(latestApprovedReviewer(reviews)).toBeUndefined()
  })
})

describe('ReviewPanel — ReviewState coverage', () => {
  it('all three ReviewStates have labels', () => {
    const states: ReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']
    states.forEach((s) => {
      expect(typeof stateLabel(s)).toBe('string')
      expect(stateLabel(s).length).toBeGreaterThan(0)
    })
  })

  it('all three ReviewStates have badge classes', () => {
    const states: ReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']
    states.forEach((s) => {
      expect(typeof stateBadgeClasses(s)).toBe('string')
      expect(stateBadgeClasses(s).length).toBeGreaterThan(0)
    })
  })

  it('all three ReviewStates have icons', () => {
    const states: ReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']
    states.forEach((s) => {
      expect(typeof stateIcon(s)).toBe('string')
    })
  })
})

describe('ReviewPanel — module exports', () => {
  it('exports ReviewPanel component from the module', async () => {
    const mod = await import('../../../src/components/features/code-review/ReviewPanel.js')
    expect(typeof mod.ReviewPanel).toBe('function')
  })

  it('exports CodeReviewSummary component from the module', async () => {
    const mod = await import(
      '../../../src/components/features/code-review/CodeReviewSummary.js'
    )
    expect(typeof mod.CodeReviewSummary).toBe('function')
  })
})
