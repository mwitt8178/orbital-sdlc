/**
 * Unit tests for routing policy loading and validation.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resetPolicyCache, BUILT_IN_DEFAULT_POLICY } from '../../../src/routing/policy.js'
import { RoutingPolicySchema } from '../../../src/routing/types.js'

describe('BUILT_IN_DEFAULT_POLICY', () => {
  afterEach(() => {
    resetPolicyCache()
  })

  it('passes RoutingPolicySchema validation', () => {
    const result = RoutingPolicySchema.safeParse(BUILT_IN_DEFAULT_POLICY)
    expect(result.success).toBe(true)
  })

  it('has schema_version=1', () => {
    expect(BUILT_IN_DEFAULT_POLICY.schema_version).toBe(1)
  })

  it('has all 4 risk class rules', () => {
    const riskClasses = BUILT_IN_DEFAULT_POLICY.risk_class_rules.map(r => r.risk_class)
    expect(riskClasses).toContain('low')
    expect(riskClasses).toContain('standard')
    expect(riskClasses).toContain('high')
    expect(riskClasses).toContain('critical')
  })

  it('low risk class floor is simple (haiku tier)', () => {
    const rule = BUILT_IN_DEFAULT_POLICY.risk_class_rules.find(r => r.risk_class === 'low')
    expect(rule?.min_capability_tier).toBe('simple')
  })

  it('standard risk class floor is default (sonnet tier)', () => {
    const rule = BUILT_IN_DEFAULT_POLICY.risk_class_rules.find(r => r.risk_class === 'standard')
    expect(rule?.min_capability_tier).toBe('default')
  })

  it('high risk class floor is complex (opus tier)', () => {
    const rule = BUILT_IN_DEFAULT_POLICY.risk_class_rules.find(r => r.risk_class === 'high')
    expect(rule?.min_capability_tier).toBe('complex')
  })

  it('critical risk class pins to opus', () => {
    const rule = BUILT_IN_DEFAULT_POLICY.risk_class_rules.find(r => r.risk_class === 'critical')
    expect(rule?.pin_model).toBe('claude-opus-4-6')
  })

  it('has persona affinities for all 11 baseline personas', () => {
    const affinityPersonaIds = BUILT_IN_DEFAULT_POLICY.persona_affinities.map(a => a.persona_id)
    const expected = ['pm', 'architect', 'principal-dev', 'security', 'sr-dev', 'verifier', 'retro-analyst', 'qa', 'em', 'jr-dev', 'scrum-master']
    for (const slug of expected) {
      expect(affinityPersonaIds, `Expected persona '${slug}' in persona_affinities`).toContain(slug)
    }
  })

  it('jr-dev and scrum-master have haiku affinity', () => {
    const jrDev = BUILT_IN_DEFAULT_POLICY.persona_affinities.find(a => a.persona_id === 'jr-dev')
    const scrumMaster = BUILT_IN_DEFAULT_POLICY.persona_affinities.find(a => a.persona_id === 'scrum-master')
    expect(jrDev?.base_model).toBe('claude-haiku-4-5')
    expect(scrumMaster?.base_model).toBe('claude-haiku-4-5')
  })

  it('pm, architect, principal-dev, security have opus affinity', () => {
    const opusPersonas = ['pm', 'architect', 'principal-dev', 'security']
    for (const slug of opusPersonas) {
      const affinity = BUILT_IN_DEFAULT_POLICY.persona_affinities.find(a => a.persona_id === slug)
      expect(affinity?.base_model, `Persona '${slug}' should have opus affinity`).toBe('claude-opus-4-6')
    }
  })

  it('sr-dev, verifier, retro-analyst, qa, em have sonnet affinity', () => {
    const sonnetPersonas = ['sr-dev', 'verifier', 'retro-analyst', 'qa', 'em']
    for (const slug of sonnetPersonas) {
      const affinity = BUILT_IN_DEFAULT_POLICY.persona_affinities.find(a => a.persona_id === slug)
      expect(affinity?.base_model, `Persona '${slug}' should have sonnet affinity`).toBe('claude-sonnet-4-6')
    }
  })

  it('has default_task_caps for all risk classes', () => {
    const caps = BUILT_IN_DEFAULT_POLICY.default_task_caps_usd_micros
    expect(caps.low).toBeGreaterThan(0)
    expect(caps.standard).toBeGreaterThan(0)
    expect(caps.high).toBeGreaterThan(0)
    expect(caps.critical).toBeGreaterThan(0)
  })
})
