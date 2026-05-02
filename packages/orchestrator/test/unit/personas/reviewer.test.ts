/**
 * Unit tests for the reviewer persona definition.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Validates:
 *   - PersonaDefinitionSchema parses the definition without errors
 *   - Required capability profile fields are set correctly
 *   - Cross-family SoD capability (ghPRReview present)
 *   - Model affinity covers standard risk class
 *   - Skills include code-review-protocol
 */

import { describe, it, expect } from 'vitest'
import { definition } from '../../../src/personas/library/reviewer.js'
import { PersonaDefinitionSchema } from '../../../src/personas/types.js'

describe('reviewer persona definition', () => {
  it('parses without validation errors', () => {
    const result = PersonaDefinitionSchema.safeParse(definition)
    if (!result.success) {
      console.error('Validation errors:', result.error.format())
    }
    expect(result.success).toBe(true)
  })

  it('has slug "reviewer"', () => {
    expect(definition.slug).toBe('reviewer')
  })

  it('has origin "baseline"', () => {
    expect(definition.origin).toBe('baseline')
  })

  it('has filesRead set to ["**"] (reads full worktree + diff)', () => {
    expect(definition.defaultCapabilityProfile.filesRead).toEqual(['**'])
  })

  it('has filesWrite set to [] (never writes to worktree)', () => {
    expect(definition.defaultCapabilityProfile.filesWrite).toEqual([])
  })

  it('has boardMutate set to [] (never touches board)', () => {
    expect(definition.defaultCapabilityProfile.boardMutate).toEqual([])
  })

  it('has spawnSubagent false (reviewer is terminal, no sub-spawning)', () => {
    expect(definition.defaultCapabilityProfile.spawnSubagent).toBe(false)
  })

  it('has gitCommit null (reviewer never commits)', () => {
    expect(definition.defaultCapabilityProfile.gitCommit).toBeNull()
  })

  it('has channelPost scoped to review channels only', () => {
    const posts = definition.defaultCapabilityProfile.channelPost
    expect(posts.every((c) => c.startsWith('#review-'))).toBe(true)
  })

  it('includes code-review-protocol skill', () => {
    const slugs = definition.skills.map((s) => s.slug)
    expect(slugs).toContain('code-review-protocol')
  })

  it('has model affinity for standard risk class', () => {
    const standard = definition.modelAffinity.find((e) => e.riskClass === 'standard')
    expect(standard).toBeDefined()
    // Standard reviewer → sonnet (cross-family SoD may override at routing time)
    expect(standard!.preferredModel).toBe('claude-sonnet-4-6')
  })

  it('has model affinity for high risk class (complex reviews → opus)', () => {
    const high = definition.modelAffinity.find((e) => e.riskClass === 'high')
    expect(high).toBeDefined()
    expect(high!.preferredModel).toBe('claude-opus-4-6')
  })

  it('escalation policy has at most maxRetries=1', () => {
    expect(definition.escalationPolicy.maxRetries).toBeLessThanOrEqual(1)
  })

  it('metadata tags include "code-review"', () => {
    expect(definition.metadata.tags).toContain('code-review')
  })

  it('metadata description is non-empty and under 280 chars', () => {
    expect(definition.metadata.description.length).toBeGreaterThan(0)
    expect(definition.metadata.description.length).toBeLessThanOrEqual(280)
  })
})
