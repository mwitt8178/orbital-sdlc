/**
 * drivers/anthropic.ts — Anthropic provider driver.
 *
 * Implements the LLMDriver interface using the @anthropic-ai/sdk.
 * Extracted from personas/anthropic-driver.ts (which becomes a thin wrapper
 * that delegates here for backwards compatibility).
 *
 * Per Round 6 #8 spec.
 */

import Anthropic from '@anthropic-ai/sdk'
import { loadEnv } from '../config/env.js'
import { logger } from '../config/logger.js'
import type {
  LLMDriver,
  LLMRequest,
  LLMResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderHealth,
  ContentBlock,
} from './types.js'
import { ProviderError } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVAILABLE_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
] as const

const HEALTH_CACHE_TTL_MS = 30_000

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class AnthropicDriver implements LLMDriver {
  readonly providerId = 'anthropic'
  readonly availableModels: readonly string[] = AVAILABLE_MODELS

  private _healthCache: { value: ProviderHealth; expiresAt: number } | null = null

  /** Test seam — override the SDK constructor. */
  private readonly _clientFactory: (apiKey: string, timeoutMs: number) => Anthropic

  constructor(opts?: {
    clientFactory?: (apiKey: string, timeoutMs: number) => Anthropic
  }) {
    this._clientFactory =
      opts?.clientFactory ??
      ((apiKey, timeoutMs) =>
        new Anthropic({
          apiKey,
          timeout: timeoutMs,
          maxRetries: 0,
        }))
  }

  async send(req: LLMRequest): Promise<LLMResponse> {
    const env = loadEnv()
    const apiKey = env.ANTHROPIC_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ProviderError('anthropic', false, undefined, 'ANTHROPIC_API_KEY is not set')
    }

    const timeoutMs = 120_000
    const client = this._clientFactory(apiKey, timeoutMs)

    let lastErr: unknown
    const maxRetries = 3

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const sdkReq: Anthropic.Messages.MessageCreateParams = {
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          messages: req.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : (m.content as Anthropic.Messages.ContentBlock[]),
          })),
        }

        if (req.system) {
          if (typeof req.system === 'string') {
            sdkReq.system = req.system
          } else {
            sdkReq.system = req.system as Anthropic.Messages.TextBlockParam[]
          }
        }

        if (req.tools && req.tools.length > 0) {
          sdkReq.tools = req.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
          }))
        }

        if (req.tool_choice) {
          sdkReq.tool_choice = req.tool_choice as Anthropic.Messages.ToolChoice
        }

        if (req.temperature !== undefined) {
          sdkReq.temperature = req.temperature
        }

        const raw = await client.messages.create(sdkReq)

        const content: ContentBlock[] = raw.content.map((b): ContentBlock => {
          if (b.type === 'text') return { type: 'text', text: b.text }
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
          return { type: 'text', text: '' }
        })

        return {
          content,
          usage: {
            input_tokens: raw.usage.input_tokens,
            output_tokens: raw.usage.output_tokens,
            cache_read: raw.usage.cache_read_input_tokens ?? 0,
            cache_write: raw.usage.cache_creation_input_tokens ?? 0,
          },
          raw,
        }
      } catch (err) {
        lastErr = err
        if (!_isRetryable(err)) throw _toProviderError(err)
        const backoffMs = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
        logger.warn(
          { attempt: attempt + 1, backoffMs, provider: 'anthropic' },
          'AnthropicDriver.send: retrying after retryable error',
        )
        await _delay(backoffMs)
      }
    }

    throw _toProviderError(lastErr)
  }

  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    // Anthropic does not expose a public embeddings API as of this writing.
    throw new ProviderError('anthropic', false, undefined, 'Anthropic does not support embeddings')
  }

  async health(): Promise<ProviderHealth> {
    const now = Date.now()
    if (this._healthCache && this._healthCache.expiresAt > now) {
      return this._healthCache.value
    }

    const env = loadEnv()
    const apiKey = env.ANTHROPIC_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'anthropic',
        lastCheckedAt: new Date().toISOString(),
        reason: 'no_api_key',
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    }

    const start = Date.now()
    try {
      const client = this._clientFactory(apiKey, 10_000)
      // Use the cheapest possible call: count_tokens or a minimal message.
      // We use models.list() as a lightweight endpoint that confirms auth.
      await client.models.list({ limit: 1 })
      const latencyMs = Date.now() - start
      const result: ProviderHealth = {
        healthy: true,
        providerId: 'anthropic',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    } catch (err) {
      const latencyMs = Date.now() - start
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'anthropic',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
        reason: err instanceof Error ? err.message : String(err),
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return true
    if (err.status !== undefined && err.status >= 500) return true
    return false
  }
  if (err instanceof Anthropic.APIConnectionError) return true
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true
  return false
}

function _toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(
      'anthropic',
      _isRetryable(err),
      err.status,
      err.message,
    )
  }
  return new ProviderError('anthropic', false, undefined, err instanceof Error ? err.message : String(err))
}

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnthropicDriver(opts?: {
  clientFactory?: (apiKey: string, timeoutMs: number) => Anthropic
}): AnthropicDriver {
  return new AnthropicDriver(opts)
}
