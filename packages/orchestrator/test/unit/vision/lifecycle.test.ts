/**
 * Unit tests for vision/lifecycle.ts
 *
 * Per TRD-01 §11.1:
 *   - Schema validation: VisionDocumentContentSchema accepts/rejects correctly.
 *   - Lock validation: missing required fields → VALIDATION_REQUIRED_FIELD_MISSING.
 *   - Open-questions block: blocking unresolved question → CONFLICT_OPEN_QUESTIONS_BLOCK_LOCK.
 *   - Confirmation token: not found → error; already used → error; expired → error.
 *   - State machine: valid transitions pass; invalid transitions raise CONFLICT_INVALID_STATE_TRANSITION.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { OrbitalError } from '@orbital/types'
import {
  assertLockAllowed,
  assertReviseAllowed,
  assertTransitionAllowed,
  validateForLock,
  issueConfirmationToken,
  consumeConfirmationToken,
  _clearTokenStore,
  computeContentHash,
} from '../../../src/vision/lifecycle.js'
import { VisionDocumentContentSchema } from '../../../src/vision/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_CONTENT = {
  schema_version: 1 as const,
  title: 'Test Vision',
  summary: 'A test vision document for unit testing.',
  goals: [{ id: 'g1', text: 'Achieve X', rank: 1 }],
  non_goals: [{ id: 'ng1', text: 'Not Y' }],
  target_users: [{ id: 'u1', segment: 'Solo Builder', description: 'Independent developer', primary: true }],
  acceptance_criteria: [{ id: 'ac1', text: 'Given X when Y then Z', rank: 1 }],
  glossary: [{ term: 'X', definition: 'X is a thing' }],
  edge_cases: [{ id: 'ec1', text: 'Empty state', surfaced_by: 'user' as const }],
  open_questions: [] as Array<{ id: string; text: string; raised_at: string; raised_by: { type: 'system'; component: 'orchestrator' }; blocking: boolean; resolved_at?: string; resolution_summary?: string }>,
  assumptions_log: [] as Array<{ id: string; text: string; appended_at: string; appended_by: { type: 'system'; component: 'orchestrator' }; confidence: 'medium'; evidence_link?: string }>,
  metadata: {
    pm_persona_id: 'pm-1',
    model_used: 'claude-sonnet-4-6',
    intake_started_at: new Date().toISOString(),
    intake_token_total: 0,
  },
}

const USER_ACTOR = { type: 'user' as const, user_id: 'u1', install_id: 'install-1' }
const PERSONA_ACTOR = { type: 'persona' as const, persona_id: 'pm-1', session_id: 'ses-1' }

// ---------------------------------------------------------------------------
// VisionDocumentContentSchema validation
// ---------------------------------------------------------------------------

describe('VisionDocumentContentSchema', () => {
  it('accepts a complete valid content object', () => {
    const result = VisionDocumentContentSchema.safeParse(FULL_CONTENT)
    expect(result.success).toBe(true)
  })

  it('rejects when schema_version is wrong', () => {
    const bad = { ...FULL_CONTENT, schema_version: 2 }
    const result = VisionDocumentContentSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects when goals is empty', () => {
    const bad = { ...FULL_CONTENT, goals: [] }
    const result = VisionDocumentContentSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects when title is missing', () => {
    const { title: _omit, ...rest } = FULL_CONTENT
    const result = VisionDocumentContentSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateForLock
// ---------------------------------------------------------------------------

describe('validateForLock', () => {
  it('returns ready=true for a complete content object', () => {
    const result = validateForLock(FULL_CONTENT, { no_edge_cases: false })
    expect(result.ready).toBe(true)
    expect(result.missing_fields).toHaveLength(0)
    expect(result.blocking_open_questions).toHaveLength(0)
  })

  it('reports missing goals', () => {
    const result = validateForLock({ ...FULL_CONTENT, goals: [] }, { no_edge_cases: false })
    expect(result.ready).toBe(false)
    expect(result.missing_fields).toContain('goals')
  })

  it('reports missing non_goals', () => {
    const result = validateForLock({ ...FULL_CONTENT, non_goals: [] }, { no_edge_cases: false })
    expect(result.missing_fields).toContain('non_goals')
  })

  it('reports missing target_users', () => {
    const result = validateForLock({ ...FULL_CONTENT, target_users: [] }, { no_edge_cases: false })
    expect(result.missing_fields).toContain('target_users')
  })

  it('reports missing acceptance_criteria', () => {
    const result = validateForLock({ ...FULL_CONTENT, acceptance_criteria: [] }, { no_edge_cases: false })
    expect(result.missing_fields).toContain('acceptance_criteria')
  })

  it('does NOT report empty glossary as missing (soft signal per TRD-01 §6.1)', () => {
    const result = validateForLock({ ...FULL_CONTENT, glossary: [] }, { no_edge_cases: false })
    expect(result.missing_fields).not.toContain('glossary')
  })

  it('does NOT report empty edge_cases as missing regardless of attestation (soft signal per TRD-01 §6.1)', () => {
    const r1 = validateForLock({ ...FULL_CONTENT, edge_cases: [] }, { no_edge_cases: false })
    expect(r1.missing_fields).not.toContain('edge_cases')

    const r2 = validateForLock({ ...FULL_CONTENT, edge_cases: [] }, { no_edge_cases: true })
    expect(r2.missing_fields).not.toContain('edge_cases')
  })

  it('reports blocking unresolved open questions', () => {
    const content = {
      ...FULL_CONTENT,
      open_questions: [
        {
          id: 'q1',
          text: 'What does X mean?',
          raised_at: new Date().toISOString(),
          raised_by: PERSONA_ACTOR,
          blocking: true,
          // resolved_at is absent
        },
      ],
    }
    const result = validateForLock(content, { no_edge_cases: false })
    expect(result.ready).toBe(false)
    expect(result.blocking_open_questions).toContain('q1')
  })

  it('does NOT report a resolved question as blocking', () => {
    const content = {
      ...FULL_CONTENT,
      open_questions: [
        {
          id: 'q1',
          text: 'What does X mean?',
          raised_at: new Date().toISOString(),
          raised_by: PERSONA_ACTOR,
          blocking: true,
          resolved_at: new Date().toISOString(),
          resolution_summary: 'Resolved',
        },
      ],
    }
    const result = validateForLock(content, { no_edge_cases: false })
    expect(result.blocking_open_questions).not.toContain('q1')
  })

  it('does NOT report a non-blocking question', () => {
    const content = {
      ...FULL_CONTENT,
      open_questions: [
        {
          id: 'q1',
          text: 'Optional question',
          raised_at: new Date().toISOString(),
          raised_by: PERSONA_ACTOR,
          blocking: false,
        },
      ],
    }
    const result = validateForLock(content, { no_edge_cases: false })
    expect(result.blocking_open_questions).not.toContain('q1')
  })
})

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

describe('assertTransitionAllowed', () => {
  it('allows drafting → locked', () => {
    expect(() => assertTransitionAllowed('drafting', 'locked')).not.toThrow()
  })

  it('allows drafting → abandoned', () => {
    expect(() => assertTransitionAllowed('drafting', 'abandoned')).not.toThrow()
  })

  it('allows locked → revised', () => {
    expect(() => assertTransitionAllowed('locked', 'revised')).not.toThrow()
  })

  it('allows revised → revised', () => {
    expect(() => assertTransitionAllowed('revised', 'revised')).not.toThrow()
  })

  it('rejects drafting → revised (invalid)', () => {
    expect(() => assertTransitionAllowed('drafting', 'revised')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })

  it('rejects locked → drafting (invalid)', () => {
    expect(() => assertTransitionAllowed('locked', 'drafting')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })

  it('rejects locked → locked (invalid)', () => {
    expect(() => assertTransitionAllowed('locked', 'locked')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })

  it('rejects abandoned → any (terminal)', () => {
    expect(() => assertTransitionAllowed('abandoned', 'locked')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })
})

describe('assertLockAllowed', () => {
  it('allows lock from drafting with user actor', () => {
    expect(() => assertLockAllowed('drafting', 'user')).not.toThrow()
  })

  it('rejects lock from locked state', () => {
    expect(() => assertLockAllowed('locked', 'user')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })

  it('rejects lock by persona actor (FR-1.3)', () => {
    expect(() => assertLockAllowed('drafting', 'persona')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })
})

describe('assertReviseAllowed', () => {
  it('allows revise from locked with user actor', () => {
    expect(() => assertReviseAllowed('locked', 'user')).not.toThrow()
  })

  it('allows revise from revised with user actor', () => {
    expect(() => assertReviseAllowed('revised', 'user')).not.toThrow()
  })

  it('rejects revise from drafting', () => {
    expect(() => assertReviseAllowed('drafting', 'user')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })

  it('rejects revise by persona actor', () => {
    expect(() => assertReviseAllowed('locked', 'persona')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_INVALID_STATE_TRANSITION' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Confirmation token lifecycle
// ---------------------------------------------------------------------------

describe('confirmation tokens', () => {
  beforeEach(() => {
    _clearTokenStore()
  })

  it('issues and consumes a valid token', () => {
    const documentId = 'doc-1'
    const token = issueConfirmationToken(documentId)
    expect(() => consumeConfirmationToken(token, documentId)).not.toThrow()
  })

  it('rejects a consumed token (single-use)', () => {
    const documentId = 'doc-2'
    const token = issueConfirmationToken(documentId)
    consumeConfirmationToken(token, documentId)
    expect(() => consumeConfirmationToken(token, documentId)).toThrow(
      expect.objectContaining({ code: 'CONFLICT_CONFIRMATION_TOKEN_USED' }),
    )
  })

  it('rejects an unknown token', () => {
    expect(() => consumeConfirmationToken('not-a-real-token', 'doc-3')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_CONFIRMATION_TOKEN_USED' }),
    )
  })

  it('rejects a token issued for a different document', () => {
    const token = issueConfirmationToken('doc-A')
    expect(() => consumeConfirmationToken(token, 'doc-B')).toThrow(
      expect.objectContaining({ code: 'CONFLICT_CONFIRMATION_TOKEN_USED' }),
    )
  })
})

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------

describe('computeContentHash', () => {
  it('produces a 64-char hex string', () => {
    const hash = computeContentHash({ title: 'test' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the same hash for the same content', () => {
    const a = computeContentHash({ x: 1, y: 2 })
    const b = computeContentHash({ x: 1, y: 2 })
    expect(a).toBe(b)
  })

  it('produces different hashes for different content', () => {
    const a = computeContentHash({ x: 1 })
    const b = computeContentHash({ x: 2 })
    expect(a).not.toBe(b)
  })
})
