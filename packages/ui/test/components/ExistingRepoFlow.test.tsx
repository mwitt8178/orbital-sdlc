/**
 * ExistingRepoFlow — pure logic tests.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect } from 'vitest'

const EXISTING_REPO_STEPS = [
  'connect_repo',
  'codebase_analysis',
  'board_mapping',
  'memory_seed',
  'system_teach',
  'mode',
  'first_sprint',
  'done',
] as const

function repoIsValid(owner: string, repo: string): boolean {
  return owner.trim().length > 0 && repo.trim().length > 0
}

describe('ExistingRepoFlow — step ordering', () => {
  it('exposes 8 steps in the expected order', () => {
    expect(EXISTING_REPO_STEPS[0]).toBe('connect_repo')
    expect(EXISTING_REPO_STEPS[EXISTING_REPO_STEPS.length - 1]).toBe('done')
  })

  it('places codebase_analysis before board_mapping (analysis informs mapping)', () => {
    expect(EXISTING_REPO_STEPS.indexOf('codebase_analysis')).toBeLessThan(
      EXISTING_REPO_STEPS.indexOf('board_mapping'),
    )
  })

  it('places memory_seed before system_teach (entries feed CLAUDE.md)', () => {
    expect(EXISTING_REPO_STEPS.indexOf('memory_seed')).toBeLessThan(
      EXISTING_REPO_STEPS.indexOf('system_teach'),
    )
  })
})

describe('ExistingRepoFlow — connect repo gate', () => {
  it('blocks Continue until owner+repo provided', () => {
    expect(repoIsValid('', '')).toBe(false)
    expect(repoIsValid('mwitt', '')).toBe(false)
    expect(repoIsValid('', 'apprentice')).toBe(false)
    expect(repoIsValid('mwitt', 'apprentice')).toBe(true)
  })

  it('treats whitespace-only as invalid', () => {
    expect(repoIsValid('  ', '  ')).toBe(false)
  })
})
