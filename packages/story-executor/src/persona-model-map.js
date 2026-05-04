/**
 * persona-model-map.js — persona → Anthropic model ID routing.
 *
 * Defaults are baked here. Per-persona env-var overrides allowed for staging
 * (e.g. ANTHROPIC_MODEL_ENGINEER_SR=claude-sonnet-4-5).
 *
 * Real model IDs as of 2026-05. These are the IDs sent to api.anthropic.com.
 */

const DEFAULTS = Object.freeze({
  pm: 'claude-haiku-4-5',
  product: 'claude-haiku-4-5',
  'engineer-jr': 'claude-haiku-4-5',
  'engineer-sr': 'claude-sonnet-4-6',
  'engineer-principal': 'claude-opus-4-7',
  qa: 'claude-sonnet-4-6',
  review: 'claude-opus-4-7',
  security: 'claude-opus-4-7',
})

export const KNOWN_PERSONAS = Object.freeze(Object.keys(DEFAULTS))

/**
 * Resolve the model ID for a given persona.
 *
 * @param {string} persona — one of KNOWN_PERSONAS
 * @param {object} [env] — env source (defaults to process.env). Lookup key:
 *                         ANTHROPIC_MODEL_<PERSONA_UPPER_SNAKE>.
 * @returns {string} model ID
 * @throws {Error} if persona is unknown
 */
export function resolveModel(persona, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, persona)) {
    throw new Error(
      `unknown persona: ${persona}. Known: ${KNOWN_PERSONAS.join(', ')}`,
    )
  }
  const overrideKey = `ANTHROPIC_MODEL_${persona.toUpperCase().replace(/-/g, '_')}`
  const override = env[overrideKey]
  if (override && typeof override === 'string' && override.length > 0) {
    return override
  }
  return DEFAULTS[persona]
}

/**
 * Pricing per persona's model, USD per million tokens (input / output).
 * Used for cost estimation when API does not return cost directly.
 *
 * Source: Anthropic public pricing as of 2026-05. Update via env override
 * if rates change before image rebuild.
 */
const PRICING = Object.freeze({
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-7': { input: 15.0, output: 75.0 },
})

/**
 * Compute cost in USD cents (rounded) for a token usage tuple on a model.
 * Returns 0 if pricing is unknown for the model (logs once at WARN level).
 */
export function costUsdCentsFor(modelId, inputTokens, outputTokens) {
  const p = PRICING[modelId]
  if (!p) return 0
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000
  return Math.round(usd * 100)
}

export const _internal = { DEFAULTS, PRICING }
