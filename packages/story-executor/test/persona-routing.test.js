/**
 * persona-routing.test.js — verifies persona → model mapping and env override.
 */

import { describe, it, expect } from 'vitest'
import { resolveModel, costUsdCentsFor, KNOWN_PERSONAS } from '../src/persona-model-map.js'

describe('persona-model-map', () => {
  it('maps each documented persona to its tier', () => {
    expect(resolveModel('pm', {})).toBe('claude-haiku-4-5')
    expect(resolveModel('product', {})).toBe('claude-haiku-4-5')
    expect(resolveModel('engineer-jr', {})).toBe('claude-haiku-4-5')
    expect(resolveModel('engineer-sr', {})).toBe('claude-sonnet-4-6')
    expect(resolveModel('qa', {})).toBe('claude-sonnet-4-6')
    expect(resolveModel('engineer-principal', {})).toBe('claude-opus-4-7')
    expect(resolveModel('review', {})).toBe('claude-opus-4-7')
    expect(resolveModel('security', {})).toBe('claude-opus-4-7')
  })

  it('exposes the full list of known personas', () => {
    expect(new Set(KNOWN_PERSONAS)).toEqual(
      new Set([
        'pm',
        'product',
        'engineer-jr',
        'engineer-sr',
        'engineer-principal',
        'qa',
        'review',
        'security',
      ]),
    )
  })

  it('honours ANTHROPIC_MODEL_<PERSONA> env override', () => {
    expect(
      resolveModel('engineer-sr', { ANTHROPIC_MODEL_ENGINEER_SR: 'claude-sonnet-4-5' }),
    ).toBe('claude-sonnet-4-5')
    expect(
      resolveModel('engineer-principal', { ANTHROPIC_MODEL_ENGINEER_PRINCIPAL: 'opus-test' }),
    ).toBe('opus-test')
  })

  it('throws on unknown persona', () => {
    expect(() => resolveModel('intern', {})).toThrow(/unknown persona/)
  })

  it('costUsdCentsFor matches public pricing within rounding', () => {
    // haiku: 1.0 / 5.0 per million → 1M in + 1M out = $6.00 = 600 cents
    expect(costUsdCentsFor('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(600)
    // sonnet: 3 / 15 per million → 100k in, 50k out = 0.30 + 0.75 = $1.05 → 105 cents
    expect(costUsdCentsFor('claude-sonnet-4-6', 100_000, 50_000)).toBe(105)
    // opus: 15 / 75 → 10k in, 10k out = 0.15 + 0.75 = $0.90 → 90 cents
    expect(costUsdCentsFor('claude-opus-4-7', 10_000, 10_000)).toBe(90)
  })

  it('costUsdCentsFor returns 0 for unknown model id', () => {
    expect(costUsdCentsFor('unknown-model', 1000, 1000)).toBe(0)
  })
})
