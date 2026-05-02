/**
 * sod.test.ts — separation-of-duties enforcement.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { checkIssue, checkRuntime } from '../../../src/capabilities/sod.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import type { Scopes, CapabilityBundle } from '@orbital/types'

const EMPTY: Scopes = {
  files_read: [],
  files_write: [],
  board_read: [],
  board_mutate: [],
  channel_read: [],
  channel_post: [],
  secrets: [],
  network_egress: [],
  spawn_subagent: false,
  git_commit: [],
  ceremony_role: [],
}

beforeEach(() => {
  resetPolicyCache()
})

describe('checkIssue', () => {
  it('rejects developer with approval-status board_mutate', () => {
    const result = checkIssue('senior-developer', {
      ...EMPTY,
      board_mutate: ['ticket:ORB-237.approval_status'],
    })
    expect(result?.rule_id).toBe('sod_dev_no_approve')
  })

  it('rejects developer with review_decision', () => {
    const result = checkIssue('senior-developer', {
      ...EMPTY,
      board_mutate: ['ticket:ORB-237.review_decision'],
    })
    expect(result?.rule_id).toBe('sod_dev_no_approve')
  })

  it('allows developer with normal status mutation', () => {
    const result = checkIssue('senior-developer', {
      ...EMPTY,
      board_mutate: ['ticket:ORB-237.status'],
    })
    expect(result).toBeNull()
  })

  it('rejects verifier with files_write granted', () => {
    const result = checkIssue('verifier', {
      ...EMPTY,
      files_write: ['src/billing/**'],
    })
    expect(result?.rule_id).toBe('sod_verifier_no_artifact_write')
  })

  it('rejects any persona with capability:* board_mutate', () => {
    const result = checkIssue('senior-developer', {
      ...EMPTY,
      board_mutate: ['capability:*'],
    })
    expect(result?.rule_id).toBe('sod_no_self_revocation')
  })

  it('rejects retro persona writing config/**', () => {
    const result = checkIssue('retro-analyst', {
      ...EMPTY,
      files_write: ['config/**'],
    })
    // Retro can match either no_self_revocation (if applicable to *) or sod_retro_no_apply.
    // The forbidden_in_default_profile rule for retro fires here.
    expect(['sod_retro_no_apply', 'sod_verifier_no_artifact_write']).toContain(result?.rule_id)
  })

  it('rejects retro-analyst with ANY files_write entry (Phase 5B SoD strengthening)', () => {
    const result = checkIssue('retro-analyst', {
      ...EMPTY,
      files_write: ['src/**'],
    })
    expect(result?.rule_id).toBe('sod_retro_no_apply')
  })

  it('rejects retro-analyst with git_commit non-empty (Phase 5B SoD strengthening)', () => {
    const result = checkIssue('retro-analyst', {
      ...EMPTY,
      git_commit: [{ branch: 'retro/*', paths: ['docs/retros/**'] }],
    })
    expect(result?.rule_id).toBe('sod_retro_no_apply')
  })

  it('allows retro-analyst with empty files_write and empty git_commit (the production issuance shape)', () => {
    const result = checkIssue('retro-analyst', {
      ...EMPTY,
      board_read: ['*'],
      channel_read: ['#sprint-test'],
    })
    expect(result).toBeNull()
  })

  it('rejects ceremony chair who is also a participant', () => {
    const selfId = 'staff-developer-002'
    const result = checkIssue(
      'staff-developer',
      { ...EMPTY, ceremony_role: ['chair'] },
      { ceremony_self_id: selfId, ceremony_participants: [selfId, 'qa-001'] },
    )
    expect(result?.rule_id).toBe('sod_ceremony_chair_not_participant')
  })

  it('allows ceremony chair who is not a participant', () => {
    const result = checkIssue(
      'staff-developer',
      { ...EMPTY, ceremony_role: ['chair'] },
      { ceremony_self_id: 'chair-001', ceremony_participants: ['qa-001'] },
    )
    expect(result).toBeNull()
  })

  it('rejects verifier whose verification_target overlaps files_write', () => {
    const result = checkIssue(
      'verifier',
      { ...EMPTY, files_write: ['src/billing/**'] },
      { verification_target: ['src/billing/invoice.ts'] },
    )
    expect(result?.rule_id).toBe('sod_verifier_no_artifact_write')
  })
})

describe('checkRuntime', () => {
  it('blocks verifier writing a readable path at runtime', () => {
    const bundle: CapabilityBundle = {
      capability_id: uuidv7(),
      install_id: uuidv7(),
      sprint_id: uuidv7(),
      task_id: uuidv7(),
      persona_id: 'verifier',
      session_id: uuidv7(),
      scopes: { ...EMPTY, files_read: ['src/billing/**'], files_write: [] },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signing_key_id: uuidv7(),
      signature: 'AAAA',
      schema_version: 1,
    }
    const r = checkRuntime(bundle, 'files.write', { path: 'src/billing/invoice.ts' })
    expect(r?.rule_id).toBe('sod_verifier_no_artifact_write')
  })

  it('passes through non-verifier writes', () => {
    const bundle: CapabilityBundle = {
      capability_id: uuidv7(),
      install_id: uuidv7(),
      sprint_id: uuidv7(),
      task_id: uuidv7(),
      persona_id: 'senior-developer',
      session_id: uuidv7(),
      scopes: { ...EMPTY, files_read: ['src/**'], files_write: ['src/**'] },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signing_key_id: uuidv7(),
      signature: 'AAAA',
      schema_version: 1,
    }
    const r = checkRuntime(bundle, 'files.write', { path: 'src/billing/invoice.ts' })
    expect(r).toBeNull()
  })
})
