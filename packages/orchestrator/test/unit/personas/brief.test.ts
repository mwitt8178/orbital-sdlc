/**
 * Unit tests for buildBrief.
 *
 * Done criteria:
 * - Returns a non-empty string
 * - Contains persona role
 * - Contains task title and description
 * - Contains acceptance_criteria summary
 * - Contains capability scope summary
 */

import { describe, it, expect } from 'vitest'
import { buildBrief } from '../../../src/personas/brief.js'
import type { Persona } from '../../../src/personas/types.js'
import type { BriefTask } from '../../../src/personas/brief.js'
import type { CapabilityBundle } from '@orbital/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockPersona: Persona = {
  personaId: 'test-persona-id',
  personaVersionId: 'test-version-id',
  slug: 'sr-dev',
  displayName: 'Senior Developer',
  origin: 'baseline',
  versionNumber: 1,
  roleBriefMd: 'You are the Senior Developer. You implement features end-to-end.',
  definitionHash: 'abc123',
  defaultCapabilityProfile: {
    filesRead: ['src/**'],
    filesWrite: ['src/**'],
    boardRead: ['*'],
    boardMutate: [],
    channelRead: ['#sprint-*'],
    channelPost: ['#sprint-*'],
    secrets: [],
    networkEgress: ['api.anthropic.com'],
    spawnSubagent: false,
    gitCommit: { branchPattern: 'feature/*', pathGlob: 'src/**' },
    ceremonyRole: 'participant',
  },
  modelAffinity: [
    { riskClass: 'standard', preferredModel: 'claude-sonnet-4-6', fallbackModel: null, maxTokensHint: 8000, rationale: 'Default' },
  ],
  escalationPolicy: { maxRetries: 3, rules: [], defaultAction: 'post_blocker' },
  skills: [{ slug: 'tdd-cycle', required: true, ordering: 10 }],
  metadata: { tags: ['engineering'], description: 'Core implementer.' },
  isArchived: false,
}

const mockTask: BriefTask = {
  task_id: 'task-001',
  title: 'Add user authentication',
  description: 'Implement JWT-based authentication with email/password login.',
  acceptance_criteria: [
    'Given a valid email and password, When POST /auth/login is called, Then a JWT is returned with 200',
    'Given an invalid password, When POST /auth/login is called, Then 401 is returned',
  ],
  risk_class: 'high',
}

const mockCapability: CapabilityBundle = {
  capability_id: 'cap-001',
  install_id: 'install-001',
  sprint_id: 'sprint-001',
  task_id: 'task-001',
  persona_id: 'sr-dev',
  session_id: 'session-001',
  scopes: {
    files_read: ['src/**', 'tests/**'],
    files_write: ['src/**'],
    board_read: ['*'],
    board_mutate: [],
    channel_read: ['#sprint-14'],
    channel_post: ['#sprint-14'],
    secrets: [],
    network_egress: ['api.anthropic.com'],
    spawn_subagent: false,
    git_commit: [{ branch: 'feature/auth', paths: ['src/**'] }],
    ceremony_role: [],
  },
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  signing_key_id: 'key-001',
  signature: 'base64signature',
  schema_version: 1,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildBrief', () => {
  it('returns a non-empty string', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toBeTruthy()
    expect(brief.length).toBeGreaterThan(100)
  })

  it('contains the persona role/display name', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('Senior Developer')
  })

  it('contains the persona roleBriefMd content', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('You are the Senior Developer')
  })

  it('contains the task title', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('Add user authentication')
  })

  it('contains the task description', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('Implement JWT-based authentication')
  })

  it('contains acceptance criteria', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('POST /auth/login')
    expect(brief).toContain('JWT is returned')
  })

  it('contains capability scope summary', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('src/**')
    expect(brief).toContain('#sprint-14')
  })

  it('contains capability ID', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('cap-001')
  })

  it('contains task ID', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('task-001')
  })

  it('contains risk class', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('high')
  })

  it('handles empty acceptance criteria gracefully', async () => {
    const taskNoAC: BriefTask = { ...mockTask, acceptance_criteria: [] }
    const brief = await buildBrief(mockPersona, taskNoAC, mockCapability)
    expect(brief).toBeTruthy()
    expect(brief).toContain('No acceptance criteria')
  })

  it('includes output format expectation', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('task.complete')
  })

  it('produces a string with multiple sections (Role, Task, Capability Scope)', async () => {
    const brief = await buildBrief(mockPersona, mockTask, mockCapability)
    expect(brief).toContain('# Role:')
    expect(brief).toContain('# Task')
    expect(brief).toContain('# Capability Scope')
  })
})
