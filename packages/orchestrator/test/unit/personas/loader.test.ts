/**
 * Unit tests for PersonaLoader — baseline library loading and schema validation.
 *
 * All 12 baseline personas must load, validate against PersonaDefinitionSchema,
 * and have non-empty defaultCapabilityProfile arrays.
 *
 * Persona count updated from 11 → 12 in Round 6 #2 when 'reviewer' was added.
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 */

import { describe, it, expect } from 'vitest'
import { PersonaDefinitionSchema } from '../../../src/personas/types.js'
import { BASELINE_PERSONAS } from '../../../src/personas/library/index.js'
import type { PersonaDefinition } from '../../../src/personas/types.js'

describe('PersonaDefinitionSchema — baseline validation', () => {
  it('accepts all 12 baseline persona definitions', () => {
    expect(BASELINE_PERSONAS).toHaveLength(12)

    for (const def of BASELINE_PERSONAS) {
      const result = PersonaDefinitionSchema.safeParse(def)
      expect(result.success, `Persona '${def.slug}' failed schema validation: ${JSON.stringify(result.error?.issues)}`).toBe(true)
    }
  })

  it('each baseline persona has a non-empty defaultCapabilityProfile', () => {
    for (const def of BASELINE_PERSONAS) {
      const profile = def.defaultCapabilityProfile
      // At minimum must have filesRead, filesWrite (can be empty arrays but must exist)
      expect(profile, `Persona '${def.slug}' missing defaultCapabilityProfile`).toBeDefined()
      expect(typeof profile.filesRead).toBe('object')
      expect(typeof profile.filesWrite).toBe('object')
      expect(typeof profile.spawnSubagent).toBe('boolean')
    }
  })

  it('each baseline persona includes standard risk class in modelAffinity', () => {
    for (const def of BASELINE_PERSONAS) {
      const hasStandard = def.modelAffinity.some((a) => a.riskClass === 'standard')
      expect(hasStandard, `Persona '${def.slug}' missing standard risk class affinity`).toBe(true)
    }
  })

  it('all slugs are unique', () => {
    const slugs = BASELINE_PERSONAS.map((d) => d.slug)
    const unique = new Set(slugs)
    expect(unique.size).toBe(BASELINE_PERSONAS.length)
  })

  it('all expected persona slugs are present', () => {
    const slugs = new Set(BASELINE_PERSONAS.map((d) => d.slug))
    const expected = [
      'pm', 'architect', 'sr-dev', 'jr-dev', 'principal-dev',
      'qa', 'security', 'scrum-master', 'em', 'retro-analyst', 'verifier',
      // Round 6 #2 — reviewer persona
      // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
      'reviewer',
    ]
    for (const slug of expected) {
      expect(slugs.has(slug), `Expected persona slug '${slug}' not found`).toBe(true)
    }
  })

  it('all personas have valid ModelId in modelAffinity', () => {
    const validModels = new Set(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'])
    for (const def of BASELINE_PERSONAS) {
      for (const a of def.modelAffinity) {
        expect(validModels.has(a.preferredModel), `Persona '${def.slug}' has invalid model '${a.preferredModel}'`).toBe(true)
        if (a.fallbackModel !== null) {
          expect(validModels.has(a.fallbackModel!), `Persona '${def.slug}' has invalid fallback '${a.fallbackModel}'`).toBe(true)
        }
      }
    }
  })

  it('all personas origin is baseline', () => {
    for (const def of BASELINE_PERSONAS) {
      expect(def.origin).toBe('baseline')
    }
  })
})

describe('PersonaDefinitionSchema — rejection cases', () => {
  const validBase: PersonaDefinition = BASELINE_PERSONAS[0]!

  it('rejects persona with secrets wildcard', () => {
    const invalid = {
      ...validBase,
      defaultCapabilityProfile: {
        ...validBase.defaultCapabilityProfile,
        secrets: ['*'],
      },
    }
    const result = PersonaDefinitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('wildcard')
  })

  it('rejects persona with invalid slug (uppercase)', () => {
    const invalid = { ...validBase, slug: 'Senior-Dev' }
    const result = PersonaDefinitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects persona without standard risk class in modelAffinity', () => {
    const invalid = {
      ...validBase,
      modelAffinity: validBase.modelAffinity.filter((a) => a.riskClass !== 'standard'),
    }
    const result = PersonaDefinitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('standard')
  })

  it('rejects escalation rule with spawn_resolver but no resolverPersona', () => {
    const invalid = {
      ...validBase,
      escalationPolicy: {
        ...validBase.escalationPolicy,
        rules: [{ trigger: 'verifier_failed' as const, action: 'spawn_resolver' as const }],
      },
    }
    const result = PersonaDefinitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('rejects persona with invalid model ID', () => {
    const invalid = {
      ...validBase,
      modelAffinity: [
        {
          riskClass: 'standard' as const,
          preferredModel: 'gpt-4' as any,
          fallbackModel: null,
          maxTokensHint: null,
          rationale: 'test',
        },
      ],
    }
    const result = PersonaDefinitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})
