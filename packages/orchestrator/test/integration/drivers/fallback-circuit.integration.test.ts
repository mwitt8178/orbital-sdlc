/**
 * Integration test: FallbackDriver circuit breaker with fixture HTTP.
 *
 * Tests AC #3: configure ANTHROPIC + OPENAI; force Anthropic 503 via fixture
 * → assert OpenAI is called → assert ProviderCallFailed + ProviderCallSucceeded.
 *
 * Tests AC #4: 5 consecutive failures → next call skips provider → emit
 * ProviderCircuitOpened.
 *
 * NOTE: Does NOT require a live Postgres connection. The circuit-breaker state
 * is in-memory. Fixture HTTP is used for both providers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFallbackDriver, type ProviderFallbackEvent } from '../../../src/drivers/fallback.js'
import { OpenAIDriver } from '../../../src/drivers/openai.js'
import { AnthropicDriver } from '../../../src/drivers/anthropic.js'
import { ProviderError } from '../../../src/drivers/types.js'
import { resetEnvCache } from '../../../src/config/env.js'
import Anthropic from '@anthropic-ai/sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicWithFixture(statusCode: number, body: unknown): AnthropicDriver {
  const fakeClient = {
    messages: {
      create: vi.fn().mockImplementation(async () => {
        if (statusCode >= 400) {
          // Create an error that instanceof-matches Anthropic.APIError so that
          // _isRetryable() in drivers/anthropic.ts correctly marks 5xx as retriable.
          const err = new Anthropic.APIError(statusCode, { type: 'error', error: { type: 'api_error', message: `HTTP ${statusCode}` } }, `HTTP ${statusCode}`, {})
          throw err
        }
        return body
      }),
    },
    models: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
  return new AnthropicDriver({ clientFactory: () => fakeClient as never })
}

function makeOpenAIWithFixture(
  chatResponse: { ok: boolean; status: number; body: unknown },
): OpenAIDriver {
  const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
    // Distinguish models list vs chat completions
    if (url.includes('/models')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }] }), text: async () => '' }
    }
    const { ok, status, body } = chatResponse
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
  })
  return new OpenAIDriver({ fetch: fakeFetch as never })
}

const VALID_OPENAI_RESPONSE = {
  choices: [{ message: { role: 'assistant', content: 'openai response' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 5 },
}

const VALID_ANTHROPIC_RESPONSE = {
  content: [{ type: 'text', text: 'anthropic response' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 5 },
}

// ---------------------------------------------------------------------------
// Tests — AC #3: Anthropic 503 → falls through to OpenAI
// ---------------------------------------------------------------------------

describe('FallbackDriver integration — provider fallback (AC #3)', () => {
  beforeEach(() => {
    resetEnvCache()
    process.env['ANTHROPIC_API_KEY'] = 'sk-test'
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
  })

  it('falls through from Anthropic 503 to OpenAI and emits correct events', async () => {
    const events: ProviderFallbackEvent[] = []
    const emitter = { emit: (e: ProviderFallbackEvent) => { events.push(e) } }

    const anthropic = makeAnthropicWithFixture(503, null)
    const openai = makeOpenAIWithFixture({ ok: true, status: 200, body: VALID_OPENAI_RESPONSE })

    const fallback = createFallbackDriver([anthropic, openai], emitter)

    const result = await fallback.send({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    })

    // OpenAI response was used
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'openai response' })

    // Events: ProviderCallFailed for anthropic, ProviderCallSucceeded for openai
    const failed = events.filter((e) => e.type === 'ProviderCallFailed')
    const succeeded = events.filter((e) => e.type === 'ProviderCallSucceeded')

    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed[0]).toMatchObject({ type: 'ProviderCallFailed', providerId: 'anthropic' })

    expect(succeeded.length).toBeGreaterThanOrEqual(1)
    expect(succeeded[0]).toMatchObject({ type: 'ProviderCallSucceeded', providerId: 'openai' })
  })
})

// ---------------------------------------------------------------------------
// Tests — AC #4: 5 consecutive failures → circuit open → next call skips
// ---------------------------------------------------------------------------

describe('FallbackDriver integration — circuit breaker (AC #4)', () => {
  beforeEach(() => {
    resetEnvCache()
    process.env['ANTHROPIC_API_KEY'] = 'sk-test'
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
  })

  it('opens circuit after 5 consecutive failures and skips on 6th call', async () => {
    const events: ProviderFallbackEvent[] = []
    const emitter = { emit: (e: ProviderFallbackEvent) => { events.push(e) } }

    // Anthropic always returns 503 (retriable)
    const anthropic = makeAnthropicWithFixture(503, null)
    const openai = makeOpenAIWithFixture({ ok: true, status: 200, body: VALID_OPENAI_RESPONSE })

    const fallback = createFallbackDriver([anthropic, openai], emitter)

    // 5 calls — each time anthropic fails, openai succeeds
    for (let i = 0; i < 5; i++) {
      await fallback.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] })
    }

    // Verify circuit was opened
    const opened = events.filter((e) => e.type === 'ProviderCircuitOpened')
    expect(opened.length).toBeGreaterThanOrEqual(1)
    if (opened[0]?.type === 'ProviderCircuitOpened') {
      expect(opened[0].providerId).toBe('anthropic')
    }

    // Verify circuit state
    const snaps = fallback.getCircuitSnapshots()
    expect(snaps['anthropic']?.state).toBe('open')

    // 6th call: anthropic should be skipped (circuit open), openai serves directly
    const anthropicSendSpy = vi.spyOn(anthropic, 'send')
    vi.clearAllMocks()

    await fallback.send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] })
    expect(anthropicSendSpy).not.toHaveBeenCalled()
  })
})
