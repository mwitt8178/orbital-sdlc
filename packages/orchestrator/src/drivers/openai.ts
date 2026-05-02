/**
 * drivers/openai.ts — OpenAI provider driver.
 *
 * Translates LLMRequest to OpenAI Chat Completions API. Tools mapped to
 * OpenAI tool-calling format. Supports gpt-4-turbo, gpt-4o, gpt-4o-mini.
 *
 * If OPENAI_API_KEY is not set, the driver loads but health() returns
 * { healthy: false, reason: 'no_api_key' }.
 *
 * Per Round 6 #8 spec.
 */

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
  'gpt-4-turbo',
  'gpt-4o',
  'gpt-4o-mini',
] as const

const HEALTH_CACHE_TTL_MS = 30_000
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

// ---------------------------------------------------------------------------
// OpenAI wire shapes (minimal — no SDK dep to keep bundle small)
// ---------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
  }
}

interface OpenAIEmbedRequest {
  model: string
  input: string | string[]
}

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[] }>
  usage: { prompt_tokens: number }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export type OpenAIFetch = typeof fetch

export class OpenAIDriver implements LLMDriver {
  readonly providerId = 'openai'
  readonly availableModels: readonly string[] = AVAILABLE_MODELS

  private _healthCache: { value: ProviderHealth; expiresAt: number } | null = null
  private readonly _fetch: OpenAIFetch

  constructor(opts?: { fetch?: OpenAIFetch }) {
    this._fetch = opts?.fetch ?? globalThis.fetch
  }

  async send(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = this._getApiKey()

    const messages: OpenAIChatMessage[] = []

    // System prompt → system message
    if (req.system) {
      const sysText = typeof req.system === 'string'
        ? req.system
        : req.system.map((b) => b.text).join('\n')
      messages.push({ role: 'system', content: sysText })
    }

    // User/assistant messages
    for (const m of req.messages) {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n')
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content })
    }

    const body: OpenAIChatRequest = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
    }

    if (req.temperature !== undefined) body.temperature = req.temperature

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    }

    if (req.tool_choice) {
      if (req.tool_choice.type === 'tool') {
        body.tool_choice = { type: 'function', function: { name: req.tool_choice.name } }
      } else {
        body.tool_choice = 'auto'
      }
    }

    let lastErr: unknown
    const maxRetries = 3

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const raw = await this._post<OpenAIChatResponse>('/chat/completions', body, apiKey)
        const choice = raw.choices[0]
        if (!choice) throw new ProviderError('openai', false, undefined, 'No choices in response')

        const content: ContentBlock[] = []

        if (choice.message.content) {
          content.push({ type: 'text', text: choice.message.content })
        }

        if (choice.message.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            let parsedInput: unknown = {}
            try {
              parsedInput = JSON.parse(tc.function.arguments)
            } catch {
              parsedInput = { _raw: tc.function.arguments }
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput,
            })
          }
        }

        return {
          content,
          usage: {
            input_tokens: raw.usage.prompt_tokens,
            output_tokens: raw.usage.completion_tokens,
          },
          raw,
        }
      } catch (err) {
        lastErr = err
        if (!_isRetryable(err)) throw err instanceof ProviderError ? err : _toProviderError(err)
        const backoffMs = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
        logger.warn(
          { attempt: attempt + 1, backoffMs, provider: 'openai' },
          'OpenAIDriver.send: retrying after retryable error',
        )
        await _delay(backoffMs)
      }
    }

    throw lastErr instanceof ProviderError ? lastErr : _toProviderError(lastErr)
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const apiKey = this._getApiKey()
    const body: OpenAIEmbedRequest = { model: req.model, input: req.input }
    const raw = await this._post<OpenAIEmbedResponse>('/embeddings', body, apiKey)
    return {
      embeddings: raw.data.map((d) => d.embedding),
      usage: { input_tokens: raw.usage.prompt_tokens },
    }
  }

  async health(): Promise<ProviderHealth> {
    const now = Date.now()
    if (this._healthCache && this._healthCache.expiresAt > now) {
      return this._healthCache.value
    }

    const env = loadEnv()
    const apiKey = env.OPENAI_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'openai',
        lastCheckedAt: new Date().toISOString(),
        reason: 'no_api_key',
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    }

    const start = Date.now()
    try {
      // Lightweight: list models endpoint
      const res = await this._fetch(`${OPENAI_BASE_URL}/models?limit=1`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      const latencyMs = Date.now() - start
      const healthy = res.ok
      const result: ProviderHealth = {
        healthy,
        providerId: 'openai',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
        reason: healthy ? undefined : `HTTP ${res.status}`,
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    } catch (err) {
      const latencyMs = Date.now() - start
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'openai',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
        reason: err instanceof Error ? err.message : String(err),
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _getApiKey(): string {
    const env = loadEnv()
    const apiKey = env.OPENAI_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ProviderError('openai', false, undefined, 'OPENAI_API_KEY is not set')
    }
    return apiKey
  }

  private async _post<T>(path: string, body: unknown, apiKey: string): Promise<T> {
    const res = await this._fetch(`${OPENAI_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const retriable = res.status === 429 || res.status >= 500
      throw new ProviderError('openai', retriable, res.status, `OpenAI HTTP ${res.status}: ${text}`)
    }

    return res.json() as Promise<T>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retriable
  return false
}

function _toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  return new ProviderError('openai', false, undefined, err instanceof Error ? err.message : String(err))
}

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAIDriver(opts?: { fetch?: OpenAIFetch }): OpenAIDriver {
  return new OpenAIDriver(opts)
}
