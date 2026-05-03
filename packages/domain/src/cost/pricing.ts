/**
 * cost/pricing.ts — Canonical Anthropic model pricing table.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Source: https://www.anthropic.com/pricing
 * Verified: 2026-05-02
 *
 * Values are USD per 1,000,000 tokens (per-million pricing).
 * Keep in sync with the public pricing page. Mark stale with a
 * TODO if the page has been updated and this file has not.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /** USD per 1M cache-read tokens. */
  cacheRead: number
  /** USD per 1M cache-write tokens. */
  cacheWrite: number
}

/**
 * Pricing table keyed by model identifier.
 *
 * Source: https://www.anthropic.com/pricing
 * As of: 2026-05-02
 *
 * Models not present in this table fall back to a safe default.
 */
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic models — per-million USD
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
  'claude-haiku-4-5':  { input:  1.00, output:  5.00, cacheRead: 0.10,  cacheWrite:  1.25 },
  // Legacy aliases — keep for backward compatibility
  'claude-opus-4':     { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4':   { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
  'claude-haiku-4':    { input:  1.00, output:  5.00, cacheRead: 0.10,  cacheWrite:  1.25 },
}

/**
 * Fallback pricing used when the model is not in the PRICING table.
 * Conservatively uses Sonnet-4.6 rates to avoid under-counting.
 */
const FALLBACK_PRICING: ModelPricing = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 }

/**
 * Return pricing for a given model identifier.
 * If not found, returns the fallback (Sonnet) pricing.
 */
export function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK_PRICING
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Compute cost in USD for a token usage record against a given model.
 *
 * Precision: stored to 6 decimal places (numeric(12,6) in DB).
 * Arithmetic: per-million pricing × token count / 1,000,000.
 *
 * AC: 'claude-sonnet-4-6' with 1M input + 1M output = $3.00 + $15.00 = $18.00
 */
export function computeCostUsd(model: string, usage: TokenUsage): number {
  const p = getPricing(model)
  const inputCost  = (usage.inputTokens  / 1_000_000) * p.input
  const outputCost = (usage.outputTokens / 1_000_000) * p.output
  const cacheReadCost  = ((usage.cacheReadTokens  ?? 0) / 1_000_000) * p.cacheRead
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.cacheWrite
  // Round to 6 decimal places to match numeric(12,6) column
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 1_000_000) / 1_000_000
}
