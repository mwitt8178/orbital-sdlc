/**
 * Tests for TriggerRulesPanel registry — pure logic, no DOM.
 *
 * Verifies the hardcoded TRIGGER_RULES_REGISTRY constant so that
 * accidental edits that drop or duplicate rules are caught immediately.
 */

import { describe, it, expect } from 'vitest'
import { TRIGGER_RULES_REGISTRY } from './TriggerRulesPanel.js'

describe('TRIGGER_RULES_REGISTRY', () => {
  it('contains exactly 13 rules', () => {
    expect(TRIGGER_RULES_REGISTRY).toHaveLength(13)
  })

  it('every rule has a non-empty rule_id, displayName, and condition', () => {
    for (const rule of TRIGGER_RULES_REGISTRY) {
      expect(rule.rule_id.length).toBeGreaterThan(0)
      expect(rule.displayName.length).toBeGreaterThan(0)
      expect(rule.condition.length).toBeGreaterThan(0)
    }
  })

  it('all rule_ids are unique', () => {
    const ids = TRIGGER_RULES_REGISTRY.map((r) => r.rule_id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('includes the 13 expected rule_ids', () => {
    const ids = new Set(TRIGGER_RULES_REGISTRY.map((r) => r.rule_id))
    const expected = [
      'backlog-grooming',
      'sprint-planning',
      'continuous-flow',
      'mid-sprint-sync',
      'sprint-review',
      'retro',
      'tie-breaker',
      'blocker-resolve',
      'architecture-review',
      'code-conflict',
      'budget-review',
      'security-review',
      'vision-drift',
    ]
    for (const id of expected) {
      expect(ids.has(id), `Missing rule_id: ${id}`).toBe(true)
    }
  })

  it('rule_ids use only lowercase letters and hyphens', () => {
    for (const rule of TRIGGER_RULES_REGISTRY) {
      expect(rule.rule_id).toMatch(/^[a-z-]+$/)
    }
  })
})
