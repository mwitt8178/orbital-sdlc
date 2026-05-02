/**
 * Unit tests for CeremonyService helpers.
 *
 * `estimateTokens` is the in-process tokenizer fallback used to enforce per-turn
 * token budgets. We don't import @anthropic-ai/tokenizer in v1; a 1-token-per-4-char
 * heuristic is used.
 */

import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../../../src/comms/ceremonies.js'

describe('estimateTokens', () => {
  it('returns at least 1 for a single character', () => {
    expect(estimateTokens('x')).toBeGreaterThanOrEqual(1)
  })

  it('approximates ~1 token per 4 chars', () => {
    expect(estimateTokens('1234567890123456')).toBe(4)
  })

  it('rounds up partial tokens', () => {
    expect(estimateTokens('12345')).toBe(2) // ceil(5/4) = 2
  })

  it('handles empty input as at least 1', () => {
    expect(estimateTokens('')).toBeGreaterThanOrEqual(1)
  })

  it('produces increasing tokens for increasing length', () => {
    const a = estimateTokens('a'.repeat(40))
    const b = estimateTokens('a'.repeat(80))
    expect(b).toBeGreaterThan(a)
  })
})
