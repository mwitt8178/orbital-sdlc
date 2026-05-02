/**
 * Unit tests for drivers/anthropic.ts
 *
 * Fixtures stub HTTP at the fetch boundary — no live Anthropic calls.
 * The AnthropicDriver uses the @anthropic-ai/sdk; we intercept via the
 * clientFactory seam.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicDriver, createAnthropicDriver } from '../../../src/drivers/anthropic.js'
import { ProviderError } from '../../../src/drivers/types.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(
  response: {
    content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>
    stop_reason: string
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  } | Error,
) {
  return {
    messages: {
      create: vi.fn().mockImplementation(() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
      ),
    },
    models: {
      list: vi.fn().mockResolvedValue({ data: [{ id: 'claude-sonnet-4-6' }] }),
    },
  }
}

const FAKE_RESPONSE = {
  content: [{ type: 'text' as const, text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicDriver', () => {
  beforeEach(() => {
    resetEnvCache()
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key'
  })

  it('exports providerId = anthropic', () => {
    const driver = createAnthropicDriver()
    expect(driver.providerId).toBe('anthropic')
  })

  it('lists available models', () => {
    const driver = createAnthropicDriver()
    expect(driver.availableModels).toContain('claude-sonnet-4-6')
    expect(driver.availableModels).toContain('claude-haiku-4-5')
  })

  it('send() calls the SDK and returns normalized LLMResponse', async () => {
    const fakeClient = makeFakeClient(FAKE_RESPONSE)
    const driver = createAnthropicDriver({
      clientFactory: () => fakeClient as never,
    })

    const result = await driver.send({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(fakeClient.messages.create).toHaveBeenCalledOnce()
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  it('send() throws ProviderError when ANTHROPIC_API_KEY is missing', async () => {
    resetEnvCache()
    delete process.env['ANTHROPIC_API_KEY']

    const driver = createAnthropicDriver()
    await expect(
      driver.send({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(ProviderError)
  })

  it('health() returns healthy=false with reason=no_api_key when key missing', async () => {
    resetEnvCache()
    delete process.env['ANTHROPIC_API_KEY']

    const driver = createAnthropicDriver()
    const result = await driver.health()
    expect(result.healthy).toBe(false)
    expect(result.reason).toBe('no_api_key')
    expect(result.providerId).toBe('anthropic')
  })

  it('health() returns healthy=true when models.list() succeeds', async () => {
    const fakeClient = makeFakeClient(FAKE_RESPONSE)
    const driver = createAnthropicDriver({
      clientFactory: () => fakeClient as never,
    })

    const result = await driver.health()
    expect(fakeClient.models.list).toHaveBeenCalledOnce()
    expect(result.healthy).toBe(true)
    expect(result.providerId).toBe('anthropic')
  })

  it('send() maps tool_use blocks correctly', async () => {
    const toolResponse = {
      content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'my_tool', input: { x: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 8 },
    }
    const fakeClient = makeFakeClient(toolResponse)
    const driver = createAnthropicDriver({ clientFactory: () => fakeClient as never })

    const result = await driver.send({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'my_tool', input_schema: { type: 'object', properties: {} } }],
    })

    const block = result.content[0]
    expect(block?.type).toBe('tool_use')
    if (block?.type === 'tool_use') {
      expect(block.name).toBe('my_tool')
      expect(block.input).toEqual({ x: 1 })
    }
  })
})
