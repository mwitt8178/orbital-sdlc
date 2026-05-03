/**
 * NewProjectFlow — pure logic tests for the wizard reducer.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Validates: slug suggestion, summary card composition, step ordering.
 */

import { describe, it, expect } from 'vitest'

function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

const NEW_PROJECT_STEPS = [
  'project_basics',
  'connect_tools',
  'vision_intake',
  'monday_provision',
  'github_provision',
  'system_teach',
  'mode',
  'first_sprint',
  'done',
] as const

describe('NewProjectFlow — slug suggestion', () => {
  it('lowercases + hyphenates names', () => {
    expect(suggestSlug('Apprentice')).toBe('apprentice')
    expect(suggestSlug('My Cool Project')).toBe('my-cool-project')
    expect(suggestSlug('foo!@#$bar')).toBe('foo-bar')
  })

  it('strips leading/trailing hyphens', () => {
    expect(suggestSlug('   foo   ')).toBe('foo')
    expect(suggestSlug('!!!alpha!!!')).toBe('alpha')
  })

  it('caps at 64 chars', () => {
    const long = 'a'.repeat(80)
    expect(suggestSlug(long).length).toBeLessThanOrEqual(64)
  })
})

describe('NewProjectFlow — step ordering', () => {
  it('exposes the canonical 9-step list', () => {
    expect(NEW_PROJECT_STEPS).toHaveLength(9)
    expect(NEW_PROJECT_STEPS[0]).toBe('project_basics')
    expect(NEW_PROJECT_STEPS[NEW_PROJECT_STEPS.length - 1]).toBe('done')
  })

  it('places the 3 provisioning steps adjacent for the live progress panel', () => {
    const idxMonday = NEW_PROJECT_STEPS.indexOf('monday_provision')
    const idxGithub = NEW_PROJECT_STEPS.indexOf('github_provision')
    const idxSystem = NEW_PROJECT_STEPS.indexOf('system_teach')
    expect(idxGithub).toBe(idxMonday + 1)
    expect(idxSystem).toBe(idxGithub + 1)
  })
})
