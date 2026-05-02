/**
 * KillAllModal unit tests — pure form validation logic.
 *
 * Tests the canSubmit logic (reason + confirmed), label generation,
 * and scope formatting without DOM renderer.
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from KillAllModal.tsx)
// ---------------------------------------------------------------------------

function canSubmit(confirmed: boolean, reason: string): boolean {
  return confirmed && reason.trim().length > 0
}

function modalTitle(scope: string, scopeLabel: string): string {
  return `Kill all workers in ${scope}: ${scopeLabel}`
}

function confirmationText(scope: string, scopeLabel: string): string {
  return `This will send SIGTERM to every active worker in ${scope}: ${scopeLabel}. This action cannot be undone.`
}

function scopeDisplayLabel(scope: string, scopeId: string): string {
  return `${scope} ${scopeId.slice(0, 8)}…`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KillAllModal — canSubmit', () => {
  it('returns false when not confirmed', () => {
    expect(canSubmit(false, 'budget_exceeded')).toBe(false)
  })

  it('returns false when reason is empty', () => {
    expect(canSubmit(true, '')).toBe(false)
  })

  it('returns false when reason is only whitespace', () => {
    expect(canSubmit(true, '   ')).toBe(false)
  })

  it('returns true when confirmed and reason is non-empty', () => {
    expect(canSubmit(true, 'budget_exceeded')).toBe(true)
  })

  it('returns true with whitespace-padded reason that has content', () => {
    expect(canSubmit(true, '  budget_exceeded  ')).toBe(true)
  })
})

describe('KillAllModal — modalTitle', () => {
  it('formats sprint scope', () => {
    expect(modalTitle('sprint', 'Sprint 42')).toBe('Kill all workers in sprint: Sprint 42')
  })

  it('formats project scope', () => {
    expect(modalTitle('project', 'My Project')).toBe('Kill all workers in project: My Project')
  })
})

describe('KillAllModal — confirmationText', () => {
  it('includes the scope and label', () => {
    const text = confirmationText('sprint', 'Sprint Alpha')
    expect(text).toContain('sprint: Sprint Alpha')
    expect(text).toContain('SIGTERM')
    expect(text).toContain('cannot be undone')
  })
})

describe('KillAllModal — scopeDisplayLabel', () => {
  it('truncates long uuid to 8 chars', () => {
    const label = scopeDisplayLabel('sprint', 'abcdef12-1234-5678-9012-abcdef123456')
    expect(label).toBe('sprint abcdef12…')
  })

  it('works with short ids', () => {
    const label = scopeDisplayLabel('project', 'shortid')
    expect(label).toContain('project')
  })
})
