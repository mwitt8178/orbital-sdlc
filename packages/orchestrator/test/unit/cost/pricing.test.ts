/**
 * Unit tests for cost/pricing.ts
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect } from 'vitest'
import { computeCostUsd, getPricing, PRICING } from '../../../src/cost/pricing.js'

describe('PRICING table', () => {
  it('contains claude-sonnet-4-6 with correct rates', () => {
    const p = PRICING['claude-sonnet-4-6']
    expect(p).toBeDefined()
    expect(p!.input).toBe(3.00)
    expect(p!.output).toBe(15.00)
    expect(p!.cacheRead).toBe(0.30)
    expect(p!.cacheWrite).toBe(3.75)
  })

  it('contains claude-opus-4-7 with correct rates', () => {
    const p = PRICING['claude-opus-4-7']
    expect(p).toBeDefined()
    expect(p!.input).toBe(15.00)
    expect(p!.output).toBe(75.00)
  })

  it('contains claude-haiku-4-5 with correct rates', () => {
    const p = PRICING['claude-haiku-4-5']
    expect(p).toBeDefined()
    expect(p!.input).toBe(1.00)
    expect(p!.output).toBe(5.00)
  })
})

describe('getPricing', () => {
  it('returns known model pricing', () => {
    const p = getPricing('claude-sonnet-4-6')
    expect(p.input).toBe(3.00)
  })

  it('returns fallback pricing for unknown model', () => {
    const p = getPricing('some-future-model-9000')
    // Falls back to Sonnet rates
    expect(p.input).toBe(3.00)
    expect(p.output).toBe(15.00)
  })
})

describe('computeCostUsd', () => {
  /**
   * Acceptance criterion #6:
   * 'claude-sonnet-4-6' with 1M input + 1M output = $3.00 + $15.00 = $18.00
   */
  it('AC-6: claude-sonnet-4-6 1M input + 1M output = $18.00', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:  1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(18.00)
  })

  it('zero tokens = zero cost', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:  0,
      outputTokens: 0,
    })
    expect(cost).toBe(0)
  })

  it('opus 1M input + 1M output = $90.00', () => {
    const cost = computeCostUsd('claude-opus-4-7', {
      inputTokens:  1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(90.00)
  })

  it('haiku 1M input + 1M output = $6.00', () => {
    const cost = computeCostUsd('claude-haiku-4-5', {
      inputTokens:  1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBe(6.00)
  })

  it('includes cache read tokens in cost calculation', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:     0,
      outputTokens:    0,
      cacheReadTokens: 1_000_000,
    })
    // $0.30 per 1M cache read
    expect(cost).toBe(0.30)
  })

  it('includes cache write tokens in cost calculation', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:      0,
      outputTokens:     0,
      cacheWriteTokens: 1_000_000,
    })
    // $3.75 per 1M cache write
    expect(cost).toBe(3.75)
  })

  it('computes fractional token costs', () => {
    // 100k input = $0.30
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:  100_000,
      outputTokens: 0,
    })
    expect(cost).toBe(0.30)
  })

  it('rounds to 6 decimal places', () => {
    // 1 token = $3 / 1_000_000 = $0.000003
    const cost = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:  1,
      outputTokens: 0,
    })
    expect(cost).toBe(0.000003)
  })
})
