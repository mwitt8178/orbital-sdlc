/**
 * drivers/types.ts — shared interface contract for all LLM provider drivers.
 *
 * Every driver (Anthropic, OpenAI, Bedrock) must implement LLMDriver.
 * The FallbackDriver wraps multiple LLMDriver instances.
 *
 * Per Round 6 #8 spec.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ContentBlock = TextBlock | ToolUseBlock

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface LLMRequest {
  model: string
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  messages: Message[]
  tools?: ToolDef[]
  tool_choice?: { type: 'tool'; name: string } | { type: 'auto' }
  maxTokens?: number
  temperature?: number
}

export interface LLMResponse {
  content: ContentBlock[]
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read?: number
    cache_write?: number
  }
  /** Provider-shaped raw body for replay capture. */
  raw?: unknown
}

export interface EmbedRequest {
  model: string
  input: string | string[]
}

export interface EmbedResponse {
  embeddings: number[][]
  usage: { input_tokens: number }
}

// ---------------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------------

export interface ProviderHealth {
  healthy: boolean
  providerId: string
  latencyMs?: number
  lastCheckedAt: string
  reason?: string
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

export interface LLMDriver {
  readonly providerId: string
  readonly availableModels: readonly string[]
  send(req: LLMRequest): Promise<LLMResponse>
  embed?(req: EmbedRequest): Promise<EmbedResponse>
  health(): Promise<ProviderHealth>
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly retriable: boolean,
    public readonly httpStatus?: number,
    message?: string,
  ) {
    super(message ?? `Provider ${providerId} error${httpStatus ? ` (HTTP ${httpStatus})` : ''}`)
    this.name = 'ProviderError'
  }
}

// ---------------------------------------------------------------------------
// Model choice (for routing)
// ---------------------------------------------------------------------------

export interface ModelChoice {
  provider: string
  model: string
}

// ---------------------------------------------------------------------------
// Circuit breaker state
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerState {
  state: CircuitState
  consecutiveFailures: number
  lastFailureAt?: string
  openedAt?: string
  nextProbeAt?: string
}
