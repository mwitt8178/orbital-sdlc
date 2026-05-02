/**
 * drivers/bedrock.ts — AWS Bedrock provider driver.
 *
 * Uses @aws-sdk/client-bedrock-runtime. Supports Anthropic Claude models
 * hosted on Bedrock (claude-3-haiku, claude-3-sonnet, claude-3-opus, etc.).
 *
 * AWS credentials are resolved via the standard SDK credential chain
 * (env vars, ~/.aws/credentials, IAM role). If AWS_REGION / BEDROCK_AWS_REGION
 * is not set, health() returns { healthy: false, reason: 'no_aws_region' }.
 *
 * Integration tests should annotate with skipIf(!process.env.AWS_REGION).
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
  'anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-opus-20240229-v1:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
] as const

const HEALTH_CACHE_TTL_MS = 30_000

// ---------------------------------------------------------------------------
// Bedrock Converse API shapes
// ---------------------------------------------------------------------------

interface BedrockMessage {
  role: 'user' | 'assistant'
  content: Array<{ text: string } | { toolUse: { toolUseId: string; name: string; input: unknown } } | { toolResult: { toolUseId: string; content: Array<{ text: string }> } }>
}

interface BedrockTool {
  toolSpec: {
    name: string
    description?: string
    inputSchema: { json: Record<string, unknown> }
  }
}

interface BedrockConverseRequest {
  modelId: string
  messages: BedrockMessage[]
  system?: Array<{ text: string }>
  toolConfig?: {
    tools: BedrockTool[]
    toolChoice?: { tool: { name: string } } | { auto: Record<string, unknown> }
  }
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
  }
}

interface BedrockConverseResponse {
  output: {
    message: {
      role: string
      content: Array<
        | { text: string }
        | { toolUse: { toolUseId: string; name: string; input: unknown } }
      >
    }
  }
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

// ---------------------------------------------------------------------------
// Lazy SDK import (avoids hard dep when AWS creds are absent)
// ---------------------------------------------------------------------------

type BedrockRuntimeClient = {
  send: (cmd: unknown) => Promise<unknown>
}

type ConverseCommandCtor = new (input: BedrockConverseRequest) => unknown
type ListFoundationModelsCtor = new (input: Record<string, unknown>) => unknown

interface BedrockSDK {
  BedrockRuntimeClient: new (config: { region: string }) => BedrockRuntimeClient
  ConverseCommand: ConverseCommandCtor
}

interface BedrockManagementSDK {
  BedrockClient: new (config: { region: string }) => { send: (cmd: unknown) => Promise<unknown> }
  ListFoundationModelsCommand: ListFoundationModelsCtor
}

async function loadBedrockRuntimeSDK(): Promise<BedrockSDK> {
  try {
    // Dynamic import so the module loads even without @aws-sdk installed
    const mod = await import('@aws-sdk/client-bedrock-runtime' as string)
    return mod as unknown as BedrockSDK
  } catch {
    throw new ProviderError(
      'bedrock',
      false,
      undefined,
      '@aws-sdk/client-bedrock-runtime is not installed. Run: npm install @aws-sdk/client-bedrock-runtime',
    )
  }
}

async function loadBedrockManagementSDK(): Promise<BedrockManagementSDK> {
  try {
    const mod = await import('@aws-sdk/client-bedrock' as string)
    return mod as unknown as BedrockManagementSDK
  } catch {
    throw new ProviderError(
      'bedrock',
      false,
      undefined,
      '@aws-sdk/client-bedrock is not installed. Run: npm install @aws-sdk/client-bedrock',
    )
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class BedrockDriver implements LLMDriver {
  readonly providerId = 'bedrock'
  readonly availableModels: readonly string[] = AVAILABLE_MODELS

  private _healthCache: { value: ProviderHealth; expiresAt: number } | null = null

  private _getRegion(): string | null {
    const env = loadEnv()
    return env.BEDROCK_AWS_REGION ?? process.env['AWS_REGION'] ?? null
  }

  async send(req: LLMRequest): Promise<LLMResponse> {
    const region = this._getRegion()
    if (!region) {
      throw new ProviderError('bedrock', false, undefined, 'BEDROCK_AWS_REGION is not set')
    }

    const sdk = await loadBedrockRuntimeSDK()
    const client = new sdk.BedrockRuntimeClient({ region })

    const messages: BedrockMessage[] = req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content
            .filter((b) => b.type === 'text')
            .map((b) => ({ text: (b as { type: 'text'; text: string }).text })),
    }))

    const converseReq: BedrockConverseRequest = {
      modelId: req.model,
      messages,
    }

    if (req.system) {
      const sysText = typeof req.system === 'string'
        ? req.system
        : req.system.map((b) => b.text).join('\n')
      converseReq.system = [{ text: sysText }]
    }

    if (req.tools && req.tools.length > 0) {
      converseReq.toolConfig = {
        tools: req.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.input_schema },
          },
        })),
      }
      if (req.tool_choice?.type === 'tool') {
        converseReq.toolConfig.toolChoice = { tool: { name: req.tool_choice.name } }
      } else if (req.tool_choice?.type === 'auto') {
        converseReq.toolConfig.toolChoice = { auto: {} }
      }
    }

    converseReq.inferenceConfig = {
      maxTokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
    }

    let lastErr: unknown
    const maxRetries = 3

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const cmd = new sdk.ConverseCommand(converseReq)
        const raw = await client.send(cmd) as BedrockConverseResponse

        const content: ContentBlock[] = []
        for (const block of raw.output.message.content) {
          if ('text' in block && block.text) {
            content.push({ type: 'text', text: block.text })
          } else if ('toolUse' in block && block.toolUse) {
            content.push({
              type: 'tool_use',
              id: block.toolUse.toolUseId,
              name: block.toolUse.name,
              input: block.toolUse.input,
            })
          }
        }

        return {
          content,
          usage: {
            input_tokens: raw.usage.inputTokens,
            output_tokens: raw.usage.outputTokens,
          },
          raw,
        }
      } catch (err) {
        lastErr = err
        if (!_isRetryable(err)) throw _toProviderError(err)
        const backoffMs = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 100)
        logger.warn(
          { attempt: attempt + 1, backoffMs, provider: 'bedrock' },
          'BedrockDriver.send: retrying after retryable error',
        )
        await _delay(backoffMs)
      }
    }

    throw _toProviderError(lastErr)
  }

  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    // Bedrock does support embedding models (e.g. Titan Embeddings) but they
    // use the InvokeModel API, not Converse. Deferred to v2.
    throw new ProviderError('bedrock', false, undefined, 'BedrockDriver.embed not yet implemented')
  }

  async health(): Promise<ProviderHealth> {
    const now = Date.now()
    if (this._healthCache && this._healthCache.expiresAt > now) {
      return this._healthCache.value
    }

    const region = this._getRegion()
    if (!region) {
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'bedrock',
        lastCheckedAt: new Date().toISOString(),
        reason: 'no_aws_region',
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    }

    const start = Date.now()
    try {
      const mgmt = await loadBedrockManagementSDK()
      const client = new mgmt.BedrockClient({ region })
      const cmd = new mgmt.ListFoundationModelsCommand({})
      await client.send(cmd)
      const latencyMs = Date.now() - start
      const result: ProviderHealth = {
        healthy: true,
        providerId: 'bedrock',
        latencyMs,
        lastCheckedAt: new Date().toISOString(),
      }
      this._healthCache = { value: result, expiresAt: now + HEALTH_CACHE_TTL_MS }
      return result
    } catch (err) {
      const latencyMs = Date.now() - start
      const result: ProviderHealth = {
        healthy: false,
        providerId: 'bedrock',
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
  if (err instanceof ProviderError) return err.retriable
  // AWS SDK throttling: ThrottlingException, ServiceUnavailableException
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'ThrottlingException' || name === 'ServiceUnavailableException') return true
  return false
}

function _toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  const name = (err as { name?: string })?.name ?? ''
  const retriable = name === 'ThrottlingException' || name === 'ServiceUnavailableException'
  return new ProviderError('bedrock', retriable, undefined, err instanceof Error ? err.message : String(err))
}

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBedrockDriver(): BedrockDriver {
  return new BedrockDriver()
}
