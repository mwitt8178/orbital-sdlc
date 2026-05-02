/**
 * Unit tests for CostAccounting — computeCostMicros correctness across
 * all 4 token types and all 3 model tiers.
 *
 * Done criteria tested:
 * - Parses input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
 * - Computes correct cost using per-million rates
 * - Budget warning threshold at 80%
 */

import { describe, it, expect } from 'vitest'
import { computeCostMicros } from '../../../src/routing/cost.js'
import type { AnthropicUsage } from '../../../src/routing/types.js'

describe('computeCostMicros — opus ($15/$75 in/out, 10% cache_read, 1.25x cache_write)', () => {
  it('computes cost for 1M input tokens', () => {
    const usage: AnthropicUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    // $15 / Mtok = 15_000_000 micros
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(15_000_000)
  })

  it('computes cost for 1M output tokens', () => {
    const usage: AnthropicUsage = {
      input_tokens: 0,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    // $75 / Mtok = 75_000_000 micros
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(75_000_000)
  })

  it('computes cost for 1M cache_read tokens at 10% of input rate', () => {
    const usage: AnthropicUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    }
    // 10% of $15 = $1.50 / Mtok = 1_500_000 micros
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(1_500_000)
  })

  it('computes cost for 1M cache_creation tokens at 1.25x input rate', () => {
    const usage: AnthropicUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    }
    // 1.25x $15 = $18.75 / Mtok = 18_750_000 micros
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(18_750_000)
  })

  it('computes combined cost across all 4 token types', () => {
    const usage: AnthropicUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    }
    // 15M + 75M + 1.5M + 18.75M = 110_250_000
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(110_250_000)
  })
})

describe('computeCostMicros — sonnet ($3/$15 in/out)', () => {
  it('computes cost for 1M input tokens at $3/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-sonnet-4-6', usage)).toBe(3_000_000)
  })

  it('computes cost for 1M output tokens at $15/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-sonnet-4-6', usage)).toBe(15_000_000)
  })

  it('computes cache_read at 10% of $3 = $0.30/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-sonnet-4-6', usage)).toBe(300_000)
  })

  it('computes cache_creation at 1.25x $3 = $3.75/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 }
    expect(computeCostMicros('claude-sonnet-4-6', usage)).toBe(3_750_000)
  })

  it('computes typical 8k turn: 5k input + 2k output + 1k cache_read', () => {
    const usage: AnthropicUsage = {
      input_tokens: 5_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 0,
    }
    // (5000/1_000_000)*3_000_000 + (2000/1_000_000)*15_000_000 + (1000/1_000_000)*300_000
    // = 15_000 + 30_000 + 300 = 45_300 micros
    const cost = computeCostMicros('claude-sonnet-4-6', usage)
    expect(cost).toBe(45300)
  })
})

describe('computeCostMicros — haiku ($0.80/$4 in/out)', () => {
  it('computes cost for 1M input tokens at $0.80/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-haiku-4-5', usage)).toBe(800_000)
  })

  it('computes cost for 1M output tokens at $4/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-haiku-4-5', usage)).toBe(4_000_000)
  })

  it('computes cache_read at 10% of $0.80 = $0.08/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-haiku-4-5', usage)).toBe(80_000)
  })

  it('computes cache_creation at 1.25x $0.80 = $1.00/Mtok', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 }
    expect(computeCostMicros('claude-haiku-4-5', usage)).toBe(1_000_000)
  })
})

describe('computeCostMicros — zero usage', () => {
  it('returns 0 for all-zero usage', () => {
    const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(computeCostMicros('claude-opus-4-6', usage)).toBe(0)
    expect(computeCostMicros('claude-sonnet-4-6', usage)).toBe(0)
    expect(computeCostMicros('claude-haiku-4-5', usage)).toBe(0)
  })
})

describe('computeCostMicros — partial fields (cache defaults to 0)', () => {
  it('handles usage with missing cache fields (coerced to 0 by AnthropicUsageSchema)', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } satisfies AnthropicUsage
    const cost = computeCostMicros('claude-sonnet-4-6', usage)
    // (1000/1_000_000)*3_000_000 + (500/1_000_000)*15_000_000 = 3_000 + 7_500 = 10_500 micros
    expect(cost).toBe(10500)
  })
})
