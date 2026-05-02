/**
 * Unit tests for the routing engine's pure decide() function.
 *
 * Done criteria tested here:
 * - haiku for riskClass='low'
 * - sonnet for riskClass='medium'/'standard'
 * - opus for riskClass='high'/'critical'
 * - persona override applied
 * - retry escalation bumps model
 * - latency rule can downgrade (but not below risk floor)
 */

import { describe, it, expect } from 'vitest'
import { decide, buildDefaultCatalog } from '../../../src/routing/engine.js'
import { BUILT_IN_DEFAULT_POLICY } from '../../../src/routing/policy.js'
import type { RouterInput, RoutingPolicy, ModelCatalog } from '../../../src/routing/types.js'

const catalog: ModelCatalog = buildDefaultCatalog()
const policy: RoutingPolicy = BUILT_IN_DEFAULT_POLICY

function makeInput(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    task_id: 'task-001',
    persona_id: 'sr-dev',
    risk_class: 'standard',
    retry_depth: 0,
    latency_budget_ms: undefined,
    trace_id: 'trace-001',
    ...overrides,
  }
}

describe('decide() — default policy model selection by risk class', () => {
  it('selects haiku for risk_class=low with jr-dev (haiku affinity)', () => {
    const input = makeInput({ persona_id: 'jr-dev', risk_class: 'low' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('selects haiku for scrum-master with risk_class=low', () => {
    const input = makeInput({ persona_id: 'scrum-master', risk_class: 'low' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('selects sonnet for risk_class=standard with sr-dev', () => {
    const input = makeInput({ persona_id: 'sr-dev', risk_class: 'standard' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('selects sonnet for risk_class=standard with verifier', () => {
    const input = makeInput({ persona_id: 'verifier', risk_class: 'standard' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('selects opus for risk_class=high (floor=complex)', () => {
    const input = makeInput({ persona_id: 'sr-dev', risk_class: 'high' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('selects opus for risk_class=critical (pin_model=opus)', () => {
    const input = makeInput({ persona_id: 'sr-dev', risk_class: 'critical' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('selects opus for risk_class=high even with haiku-affinity persona (jr-dev)', () => {
    const input = makeInput({ persona_id: 'jr-dev', risk_class: 'high' })
    const result = decide(input, policy, catalog, 1)
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('selects opus for pm (opus affinity) regardless of standard risk', () => {
    const input = makeInput({ persona_id: 'pm', risk_class: 'standard' })
    const result = decide(input, policy, catalog, 1)
    // pm has opus affinity; standard floor is default which is lower, so stays at opus
    expect(result.model).toBe('claude-opus-4-6')
  })
})

describe('decide() — persona affinity overrides', () => {
  it('pm uses opus for standard risk', () => {
    const result = decide(makeInput({ persona_id: 'pm', risk_class: 'standard' }), policy, catalog, 1)
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('architect uses opus for standard risk', () => {
    const result = decide(makeInput({ persona_id: 'architect', risk_class: 'standard' }), policy, catalog, 1)
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('junior-dev uses haiku for low risk', () => {
    const result = decide(makeInput({ persona_id: 'jr-dev', risk_class: 'low' }), policy, catalog, 1)
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('unknown persona falls back to sonnet', () => {
    const result = decide(makeInput({ persona_id: 'unknown-persona', risk_class: 'standard' }), policy, catalog, 1)
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('reason includes persona_affinity fallback note for unknown persona', () => {
    const result = decide(makeInput({ persona_id: 'unknown-persona', risk_class: 'standard' }), policy, catalog, 1)
    expect(result.reason.rules_applied.some(r => r.rule_type === 'persona_affinity')).toBe(true)
  })
})

describe('decide() — retry escalation', () => {
  it('retry_depth=1 bumps sr-dev from sonnet to opus (+1 tier)', () => {
    const result = decide(
      makeInput({ persona_id: 'sr-dev', risk_class: 'standard', retry_depth: 1 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('retry_depth=1 bumps jr-dev from haiku to sonnet (+1 tier) for low risk', () => {
    const result = decide(
      makeInput({ persona_id: 'jr-dev', risk_class: 'low', retry_depth: 1 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('retry_depth=2 bumps jr-dev from haiku to opus (+2 tiers) for low risk', () => {
    const result = decide(
      makeInput({ persona_id: 'jr-dev', risk_class: 'low', retry_depth: 2 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('retry escalation clamps at opus (cannot go beyond complex)', () => {
    const result = decide(
      makeInput({ persona_id: 'pm', risk_class: 'standard', retry_depth: 3 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('reason records retry_escalation rule when applied', () => {
    const result = decide(
      makeInput({ persona_id: 'sr-dev', risk_class: 'standard', retry_depth: 1 }),
      policy, catalog, 1
    )
    expect(result.reason.rules_applied.some(r => r.rule_type === 'retry_escalation')).toBe(true)
  })
})

describe('decide() — latency rules', () => {
  it('latency_budget=1000ms with LOW risk downgrades jr-dev from haiku to haiku (already floor)', () => {
    // low risk floor = simple (haiku); jr-dev is already haiku; latency cannot go below floor
    // latency rule says prefer simple for < 1500ms — this matches haiku which is already there
    const result = decide(
      makeInput({ persona_id: 'jr-dev', risk_class: 'low', latency_budget_ms: 1000 }),
      policy, catalog, 1
    )
    // No downgrade needed; stays at haiku (risk floor = simple)
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('latency_budget=1000ms with STANDARD risk cannot downgrade below floor (sonnet)', () => {
    // standard risk floor = default (sonnet); latency prefer simple (haiku) would violate floor
    // so risk floor wins and model stays at sonnet
    const result = decide(
      makeInput({ persona_id: 'sr-dev', risk_class: 'standard', latency_budget_ms: 1000 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('latency_budget=1000ms with LOW risk and OPUS-affinity persona (pm) downgrades opus to haiku', () => {
    // pm has opus affinity; low risk floor = simple; latency < 1500ms → prefer simple
    // preferredTierOrder(simple=0) < currentTierOrder(complex=2) and 0 >= riskFloorOrder(0) → downgrade
    const result = decide(
      makeInput({ persona_id: 'pm', risk_class: 'low', latency_budget_ms: 1000 }),
      policy, catalog, 1
    )
    // pm + low risk floor = simple; latency rule fires; haiku allowed
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('latency rule does NOT downgrade below risk floor for high risk', () => {
    // high risk floor = complex (opus); latency should NOT override
    const result = decide(
      makeInput({ persona_id: 'sr-dev', risk_class: 'high', latency_budget_ms: 1000 }),
      policy, catalog, 1
    )
    expect(result.model).toBe('claude-opus-4-6')
  })

  it('reason records latency rule when applied (pm + low + 1000ms budget)', () => {
    const result = decide(
      makeInput({ persona_id: 'pm', risk_class: 'low', latency_budget_ms: 1000 }),
      policy, catalog, 1
    )
    expect(result.reason.rules_applied.some(r => r.rule_type === 'latency')).toBe(true)
  })
})

describe('decide() — output shape', () => {
  it('returns all required fields', () => {
    const result = decide(makeInput(), policy, catalog, 1)
    expect(result.task_id).toBe('task-001')
    expect(result.persona_id).toBe('sr-dev')
    expect(result.risk_class).toBe('standard')
    expect(result.model).toBeTruthy()
    expect(result.token_budget).toBeGreaterThan(0)
    expect(result.escalation_policy).toBeDefined()
    expect(result.reason).toBeDefined()
    expect(result.policy_version).toBe(1)
  })

  it('reason includes base_from_persona', () => {
    const result = decide(makeInput({ persona_id: 'sr-dev' }), policy, catalog, 1)
    expect(result.reason.base_from_persona).toBe('claude-sonnet-4-6')
  })

  it('records pin_model rule in reason when critical risk', () => {
    const result = decide(makeInput({ risk_class: 'critical' }), policy, catalog, 1)
    expect(result.reason.rules_applied.some(r => r.rule_type === 'pin_model')).toBe(true)
  })
})
