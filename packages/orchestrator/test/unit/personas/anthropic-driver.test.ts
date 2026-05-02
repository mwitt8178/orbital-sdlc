/**
 * Unit tests for AnthropicDriver.
 *
 * Strategy:
 *   The SDK is replaced via the `anthropicFactory` constructor seam — we hand
 *   the driver a fake Anthropic client whose `messages.create` returns a
 *   pre-canned response. This means we exercise:
 *     - tool-use payload assembly
 *     - JSON Schema generation from Zod
 *     - cache_control on the system block
 *     - response parsing + Zod validation
 *     - cost reporting
 *     - retry on retryable errors
 *
 *   without making real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  DefaultAnthropicDriver,
  AnthropicDriverNoKeyError,
  zodToJsonSchema,
} from '../../../src/personas/anthropic-driver.js'
import type { RoutingEngine } from '../../../src/routing/engine.js'
import type { CostAccounting } from '../../../src/routing/cost.js'
import { resetEnvCache } from '../../../src/config/env.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutingEngine(): RoutingEngine {
  return {
    selectModel: vi.fn().mockResolvedValue({
      decision_id: 'd-1',
      task_id: 't-1',
      persona_id: 'pm',
      risk_class: 'standard',
      retry_depth: 0,
      model: 'claude-sonnet-4-6',
      token_budget: 8000,
      escalation_policy: { on_failure: 'retry_same', max_retries: 0, escalate_after: 0 },
      reason: { base_from_persona: 'claude-sonnet-4-6', rules_applied: [] },
      policy_version: 1,
    }),
  }
}

function makeCostAccounting(): CostAccounting {
  return {
    report: vi.fn().mockResolvedValue({
      costId: 'c-1',
      costUsdMicros: 250,
      cumulativeSessionUsdMicros: 250,
      budgetState: 'ok',
    }),
    getSprintTotal: vi.fn(),
    getTaskTotal: vi.fn(),
  } as unknown as CostAccounting
}

function makeFakeAnthropic(opts: {
  toolInput?: Record<string, unknown>
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  errorOnCall?: number // throw on the n-th call (0-indexed)
  errorBuilder?: () => unknown
}) {
  let callCount = 0
  return {
    messages: {
      create: vi.fn(async () => {
        const thisCall = callCount++
        if (
          opts.errorOnCall !== undefined &&
          thisCall === opts.errorOnCall &&
          opts.errorBuilder
        ) {
          throw opts.errorBuilder()
        }
        return {
          content: [
            {
              type: 'tool_use',
              name: 'respond_with_json',
              input: opts.toolInput ?? { foo: 'bar' },
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: opts.usage?.input_tokens ?? 100,
            output_tokens: opts.usage?.output_tokens ?? 50,
            cache_read_input_tokens: opts.usage?.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: opts.usage?.cache_creation_input_tokens ?? 0,
          },
        }
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('zodToJsonSchema', () => {
  it('converts a flat object schema with primitives', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int().min(0).max(120),
      active: z.boolean(),
    })
    const json = zodToJsonSchema(schema)
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        active: { type: 'boolean' },
      },
      required: ['name', 'age', 'active'],
    })
  })

  it('handles optional properties (omitted from required)', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    })
    const json = zodToJsonSchema(schema) as { required?: string[] }
    expect(json.required).toEqual(['required'])
  })

  it('converts arrays', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    })
    const json = zodToJsonSchema(schema)
    expect(json).toMatchObject({
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    })
  })

  it('converts enums', () => {
    const schema = z.object({
      kind: z.enum(['a', 'b', 'c']),
    })
    const json = zodToJsonSchema(schema) as {
      properties: { kind: { type: string; enum: string[] } }
    }
    expect(json.properties.kind.type).toBe('string')
    expect(json.properties.kind.enum).toEqual(['a', 'b', 'c'])
  })

  it('handles nullable types via anyOf', () => {
    const schema = z.object({
      maybe: z.string().nullable(),
    })
    const json = zodToJsonSchema(schema) as {
      properties: { maybe: { anyOf: unknown[] } }
    }
    expect(Array.isArray(json.properties.maybe.anyOf)).toBe(true)
  })
})

describe('DefaultAnthropicDriver.invoke', () => {
  beforeEach(() => {
    resetEnvCache()
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
  })

  it('throws AnthropicDriverNoKeyError when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    resetEnvCache()

    const driver = new DefaultAnthropicDriver({
      routingEngine: makeRoutingEngine(),
      costAccounting: makeCostAccounting(),
      installId: 'install-1',
    })

    await expect(
      driver.invoke({
        persona: 'pm',
        riskClass: 'standard',
        sessionId: 's-1',
        systemPrompt: 'sys',
        userPrompt: 'user',
        responseSchema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toBeInstanceOf(AnthropicDriverNoKeyError)
  })

  it('parses tool-use response, validates via Zod, reports cost', async () => {
    const fakeClient = makeFakeAnthropic({
      toolInput: { greeting: 'hello', count: 3 },
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50 },
    })
    const costAccounting = makeCostAccounting()
    const driver = new DefaultAnthropicDriver({
      routingEngine: makeRoutingEngine(),
      costAccounting,
      installId: 'install-1',
      anthropicFactory: () => fakeClient as never,
    })

    const result = await driver.invoke({
      persona: 'pm',
      riskClass: 'standard',
      sessionId: 'session-abc',
      systemPrompt: 'You are the PM.',
      userPrompt: 'Hello',
      responseSchema: z.object({
        greeting: z.string(),
        count: z.number().int(),
      }),
    })

    expect(result.result).toEqual({ greeting: 'hello', count: 3 })
    expect(result.usage.input_tokens).toBe(200)
    expect(result.usage.cache_read_input_tokens).toBe(50)
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.costUsdMicros).toBe(250)

    // CostAccounting.report was called with the usage
    expect(costAccounting.report).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-abc',
        model: 'claude-sonnet-4-6',
        usage: expect.objectContaining({
          input_tokens: 200,
          output_tokens: 80,
          cache_read_input_tokens: 50,
        }),
      }),
    )
  })

  it('forces tool-use via tool_choice and includes cache_control on system block', async () => {
    const fakeClient = makeFakeAnthropic({ toolInput: { ok: true } })
    const driver = new DefaultAnthropicDriver({
      routingEngine: makeRoutingEngine(),
      costAccounting: makeCostAccounting(),
      installId: 'install-1',
      anthropicFactory: () => fakeClient as never,
    })

    await driver.invoke({
      persona: 'pm',
      riskClass: 'standard',
      sessionId: 's-1',
      systemPrompt: 'You are the PM.',
      userPrompt: 'Hi',
      responseSchema: z.object({ ok: z.boolean() }),
    })

    const callArgs = fakeClient.messages.create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArgs).toBeDefined()
    expect(callArgs['tool_choice']).toEqual({ type: 'tool', name: 'respond_with_json' })
    expect(Array.isArray(callArgs['system'])).toBe(true)
    const sys = callArgs['system'] as Array<{ cache_control?: unknown }>
    expect(sys[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(Array.isArray(callArgs['tools'])).toBe(true)
    const tools = callArgs['tools'] as Array<{ name: string; input_schema: unknown }>
    expect(tools[0]?.name).toBe('respond_with_json')
  })

  it('throws when Zod validation fails on the tool input', async () => {
    const fakeClient = makeFakeAnthropic({
      toolInput: { wrong: 'shape' }, // does not match schema
    })
    const driver = new DefaultAnthropicDriver({
      routingEngine: makeRoutingEngine(),
      costAccounting: makeCostAccounting(),
      installId: 'install-1',
      anthropicFactory: () => fakeClient as never,
    })

    await expect(
      driver.invoke({
        persona: 'pm',
        riskClass: 'standard',
        sessionId: 's-1',
        systemPrompt: 'sys',
        userPrompt: 'u',
        responseSchema: z.object({ greeting: z.string() }),
      }),
    ).rejects.toThrow(/failed Zod validation/)
  })

  it('retries on retryable errors and eventually succeeds', async () => {
    let calls = 0
    const fakeClient = {
      messages: {
        create: vi.fn(async () => {
          calls++
          if (calls < 2) {
            // Mimic a 429 by throwing an APIError-like object
            const Anthropic = (await import('@anthropic-ai/sdk')).default
            throw new Anthropic.APIError(429, undefined, 'rate limited', undefined)
          }
          return {
            content: [
              {
                type: 'tool_use',
                name: 'respond_with_json',
                input: { ok: true },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }
        }),
      },
    }
    const driver = new DefaultAnthropicDriver({
      routingEngine: makeRoutingEngine(),
      costAccounting: makeCostAccounting(),
      installId: 'install-1',
      anthropicFactory: () => fakeClient as never,
    })

    const result = await driver.invoke({
      persona: 'pm',
      riskClass: 'standard',
      sessionId: 's-1',
      systemPrompt: 'sys',
      userPrompt: 'u',
      responseSchema: z.object({ ok: z.boolean() }),
    })

    expect(result.result).toEqual({ ok: true })
    expect(calls).toBe(2)
  })
})
