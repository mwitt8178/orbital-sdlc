/**
 * Unit tests for drivers/openai.ts
 *
 * HTTP is stubbed at the fetch boundary — no live OpenAI calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIDriver, createOpenAIDriver } from '../../../src/drivers/openai.js'
import { ProviderError } from '../../../src/drivers/types.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeFetch(
  response: { ok: boolean; status: number; body: unknown } | Error,
) {
  return vi.fn().mockImplementation(async () => {
    if (response instanceof Error) throw response
    const { ok, status, body } = response
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  })
}

const FAKE_CHAT_RESPONSE = {
  choices: [
    {
      message: { role: 'assistant', content: 'hello from openai', tool_calls: undefined },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 6 },
}

const FAKE_MODELS_RESPONSE = {
  data: [{ id: 'gpt-4o' }],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIDriver', () => {
  beforeEach(() => {
    resetEnvCache()
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
  })

  it('exports providerId = openai', () => {
    const driver = createOpenAIDriver()
    expect(driver.providerId).toBe('openai')
  })

  it('lists available models', () => {
    const driver = createOpenAIDriver()
    expect(driver.availableModels).toContain('gpt-4o')
    expect(driver.availableModels).toContain('gpt-4o-mini')
  })

  it('send() returns normalized LLMResponse from chat completions', async () => {
    const fakeFetch = makeFakeFetch({ ok: true, status: 200, body: FAKE_CHAT_RESPONSE })
    const driver = createOpenAIDriver({ fetch: fakeFetch as never })

    const result = await driver.send({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello from openai' })
    expect(result.usage.input_tokens).toBe(12)
    expect(result.usage.output_tokens).toBe(6)
  })

  it('send() maps tool_calls to tool_use blocks', async () => {
    const withTools = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'do_thing', arguments: '{"key":"val"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }
    const fakeFetch = makeFakeFetch({ ok: true, status: 200, body: withTools })
    const driver = createOpenAIDriver({ fetch: fakeFetch as never })

    const result = await driver.send({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'do it' }],
      tools: [{ name: 'do_thing', input_schema: { type: 'object' } }],
    })

    const block = result.content[0]
    expect(block?.type).toBe('tool_use')
    if (block?.type === 'tool_use') {
      expect(block.name).toBe('do_thing')
      expect(block.input).toEqual({ key: 'val' })
    }
  })

  it('send() throws ProviderError when OPENAI_API_KEY is missing', async () => {
    resetEnvCache()
    delete process.env['OPENAI_API_KEY']
    const driver = createOpenAIDriver()
    await expect(
      driver.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(ProviderError)
  })

  it('send() throws retriable ProviderError on 503', async () => {
    const fakeFetch = makeFakeFetch({ ok: false, status: 503, body: { error: 'down' } })
    const driver = createOpenAIDriver({ fetch: fakeFetch as never })
    await expect(
      driver.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retriable === true,
    )
  })

  it('health() returns healthy=false with reason=no_api_key when key missing', async () => {
    resetEnvCache()
    delete process.env['OPENAI_API_KEY']
    const driver = createOpenAIDriver()
    const result = await driver.health()
    expect(result.healthy).toBe(false)
    expect(result.reason).toBe('no_api_key')
    expect(result.providerId).toBe('openai')
  })

  it('health() returns healthy=true when models endpoint returns 200', async () => {
    const fakeFetch = makeFakeFetch({ ok: true, status: 200, body: FAKE_MODELS_RESPONSE })
    const driver = createOpenAIDriver({ fetch: fakeFetch as never })
    const result = await driver.health()
    expect(result.healthy).toBe(true)
  })

  it('health() returns healthy=false when models endpoint returns 401', async () => {
    const fakeFetch = makeFakeFetch({ ok: false, status: 401, body: { error: 'unauthorized' } })
    const driver = createOpenAIDriver({ fetch: fakeFetch as never })
    const result = await driver.health()
    expect(result.healthy).toBe(false)
    expect(result.reason).toMatch(/401/)
  })
})
