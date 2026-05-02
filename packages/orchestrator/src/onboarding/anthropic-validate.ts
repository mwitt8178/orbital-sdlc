/**
 * anthropic-validate.ts — validate an Anthropic API key by making a real call.
 *
 * Strategy: send a 1-token messages.create against `claude-haiku-4-5`
 * with max_tokens=1 and a trivial prompt. Cost: roughly $0.00025 input + a
 * single output token (~$0.000004) = essentially nothing. If the SDK returns
 * a 401/403/invalid_api_key error, we surface a friendly message; any other
 * network/server error returns ok=false with the upstream message.
 *
 * The validator does NOT touch the keychain — that's the router's job after
 * a successful validation.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ConnectAnthropicResult } from './types.js'

/** Model used for validation. Cheap and fast. */
const VALIDATION_MODEL = 'claude-haiku-4-5'

/** Network timeout. Anthropic recommends ~60s; we cap at 5s for the wizard. */
const VALIDATION_TIMEOUT_MS = 5_000

export interface AnthropicValidator {
  validate(apiKey: string): Promise<ConnectAnthropicResult>
}

class DefaultAnthropicValidator implements AnthropicValidator {
  async validate(apiKey: string): Promise<ConnectAnthropicResult> {
    if (!apiKey || apiKey.trim().length === 0) {
      return { ok: false, message: 'API key is empty.' }
    }
    const client = new Anthropic({
      apiKey,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    })

    try {
      await client.messages.create({
        model: VALIDATION_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return { ok: true, balanceCents: null }
    } catch (err) {
      const message = formatError(err)
      return { ok: false, message }
    }
  }
}

function formatError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) {
      return 'Invalid API key — Anthropic rejected the credentials.'
    }
    if (err.status === 403) {
      return 'API key lacks permission to call the model. Check your account.'
    }
    if (err.status === 429) {
      return 'Rate-limited by Anthropic during validation. Try again in a moment.'
    }
    return `Anthropic API error (${err.status ?? 'unknown'}): ${err.message}`
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com — check your network connection.'
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'Anthropic API call timed out after 5s.'
  }
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

let defaultInstance: AnthropicValidator | null = null

export function getAnthropicValidator(): AnthropicValidator {
  if (!defaultInstance) defaultInstance = new DefaultAnthropicValidator()
  return defaultInstance
}

/** Test-only override. */
export function setAnthropicValidator(v: AnthropicValidator | null): void {
  defaultInstance = v
}
