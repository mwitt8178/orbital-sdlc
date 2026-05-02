/**
 * Unit tests for github/pr-body-builder.ts
 *
 * Verifies the Markdown template is built correctly from task + story + AC data.
 * No DB or HTTP calls — pure function unit tests.
 */

import { describe, it, expect } from 'vitest'
import { buildPRBody } from '../../../src/github/pr-body-builder.js'

const BASE_OPTS = {
  story: {
    title: 'As a user I can log in',
    description: 'Allow users to authenticate via email and password.',
  },
  acceptanceCriteria: [
    { title: 'Login form accepts valid credentials' },
    { title: 'Invalid credentials show an error message' },
  ],
  personaId: 'engineer-sr',
  personaDisplayName: 'Senior Engineer',
  sprint: { number: 3, id: 'sprint-uuid-abc' },
  capabilityId: 'cap-uuid-def',
  taskId: 'task-uuid-123',
}

describe('buildPRBody', () => {
  it('includes story title in the ## Story section', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('## Story')
    expect(body).toContain('As a user I can log in')
  })

  it('includes story description as a blockquote', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('> Allow users to authenticate via email and password.')
  })

  it('renders each AC as an unchecked checkbox', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('- [ ] Login form accepts valid credentials')
    expect(body).toContain('- [ ] Invalid credentials show an error message')
  })

  it('includes persona-of-record in the ## Implementation section', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('**Persona-of-record:** engineer-sr (Senior Engineer)')
  })

  it('includes sprint number and id', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('Sprint 3 (sprint-uuid-abc)')
  })

  it('includes capability attestation link', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('[Attestation chain](orbital://verify/cap-uuid-def)')
  })

  it('includes task id in the footer', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('Task task-uuid-123')
  })

  it('shows "Pending until verifier completes." when verifier result not yet available', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('Pending until verifier completes.')
  })

  it('shows verifier evidence text when verifierPassed=true and evidence provided', () => {
    const body = buildPRBody({
      ...BASE_OPTS,
      verifierPassed: true,
      verifierEvidence: 'All 3 AC checks passed.',
    })
    expect(body).toContain('All 3 AC checks passed.')
    expect(body).not.toContain('Pending until verifier completes.')
  })

  it('shows placeholder when no acceptance criteria are defined', () => {
    const body = buildPRBody({ ...BASE_OPTS, acceptanceCriteria: [] })
    expect(body).toContain('_No acceptance criteria defined._')
  })

  it('includes the Orbital footer attribution', () => {
    const body = buildPRBody(BASE_OPTS)
    expect(body).toContain('Opened by [Orbital]')
    expect(body).toContain('engineer-sr')
  })
})
