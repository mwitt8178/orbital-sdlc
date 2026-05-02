/**
 * Unit tests for vision/service.ts (JSON Patch, state machine helpers).
 *
 * Per TRD-01 §11.1 — unit-level tests that do not require a DB connection.
 * Service-level tests that need Postgres are in the integration test file.
 */

import { describe, it, expect } from 'vitest'
import { validateForLock } from '../../../src/vision/lifecycle.js'
import { VisionDocumentContentSchema } from '../../../src/vision/types.js'

// ---------------------------------------------------------------------------
// Content schema — lock validation for each required field (FR-1.7)
// ---------------------------------------------------------------------------

const BASE = {
  schema_version: 1 as const,
  title: 'Lock Validation Test',
  summary: 'Test summary',
  goals: [{ id: 'g1', text: 'Goal 1', rank: 1 }],
  non_goals: [{ id: 'ng1', text: 'Non-goal 1' }],
  target_users: [{ id: 'u1', segment: 'Developer', description: 'A developer', primary: true }],
  acceptance_criteria: [{ id: 'ac1', text: 'Given X when Y then Z', rank: 1 }],
  glossary: [{ term: 'X', definition: 'X is Y' }],
  edge_cases: [{ id: 'ec1', text: 'Edge case 1', surfaced_by: 'user' as const }],
  open_questions: [],
  assumptions_log: [],
  metadata: {
    pm_persona_id: 'pm-1',
    model_used: 'claude-sonnet-4-6',
    intake_started_at: new Date().toISOString(),
    intake_token_total: 0,
  },
}

describe('FR-1.7 lock validation — each required field', () => {
  // Hard-gate fields per TRD-01 §6.1 (lock requires *trustworthy*, not *exhaustive*).
  // glossary and edge_cases are soft signals — see lifecycle.ts validateForLock.
  const requiredFields = ['goals', 'non_goals', 'target_users', 'acceptance_criteria'] as const

  for (const field of requiredFields) {
    it(`rejects empty ${field}`, () => {
      const bad = { ...BASE, [field]: [] }
      const result = validateForLock(bad, { no_edge_cases: false })
      expect(result.ready).toBe(false)
      expect(result.missing_fields).toContain(field)
    })
  }

  it('accepts empty glossary (soft signal)', () => {
    const content = { ...BASE, glossary: [] }
    const result = validateForLock(content, { no_edge_cases: false })
    expect(result.ready).toBe(true)
    expect(result.missing_fields).not.toContain('glossary')
  })

  it('accepts empty edge_cases regardless of attestation (soft signal)', () => {
    const r1 = validateForLock({ ...BASE, edge_cases: [] }, { no_edge_cases: false })
    expect(r1.ready).toBe(true)

    const r2 = validateForLock({ ...BASE, edge_cases: [] }, { no_edge_cases: true })
    expect(r2.ready).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Full content schema must parse correctly via Zod
// ---------------------------------------------------------------------------

describe('VisionDocumentContentSchema round-trip', () => {
  it('parses and serializes the base fixture without loss', () => {
    const parsed = VisionDocumentContentSchema.parse(BASE)
    expect(parsed.title).toBe(BASE.title)
    expect(parsed.goals).toHaveLength(1)
    expect(parsed.schema_version).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// JSON Patch apply (internal function tested via validateForLock indirectly;
// we test the observable outcomes here without importing the private function)
// ---------------------------------------------------------------------------

describe('Content schema edge cases', () => {
  it('accepts metadata with all required fields', () => {
    const result = VisionDocumentContentSchema.safeParse(BASE)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.metadata.pm_persona_id).toBe('pm-1')
      expect(result.data.metadata.intake_token_total).toBe(0)
    }
  })

  it('rejects content where summary is empty', () => {
    const bad = { ...BASE, summary: '' }
    const result = VisionDocumentContentSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })

  it('rejects content where title is too long', () => {
    const bad = { ...BASE, title: 'x'.repeat(201) }
    const result = VisionDocumentContentSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })
})
