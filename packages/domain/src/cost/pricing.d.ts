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
    input: number;
    /** USD per 1M output tokens. */
    output: number;
    /** USD per 1M cache-read tokens. */
    cacheRead: number;
    /** USD per 1M cache-write tokens. */
    cacheWrite: number;
}
/**
 * Pricing table keyed by model identifier.
 *
 * Source: https://www.anthropic.com/pricing
 * As of: 2026-05-02
 *
 * Models not present in this table fall back to a safe default.
 */
export declare const PRICING: Record<string, ModelPricing>;
/**
 * Return pricing for a given model identifier.
 * If not found, returns the fallback (Sonnet) pricing.
 */
export declare function getPricing(model: string): ModelPricing;
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/**
 * Compute cost in USD for a token usage record against a given model.
 *
 * Precision: stored to 6 decimal places (numeric(12,6) in DB).
 * Arithmetic: per-million pricing × token count / 1,000,000.
 *
 * AC: 'claude-sonnet-4-6' with 1M input + 1M output = $3.00 + $15.00 = $18.00
 */
export declare function computeCostUsd(model: string, usage: TokenUsage): number;
//# sourceMappingURL=pricing.d.ts.map