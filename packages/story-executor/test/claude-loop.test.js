/**
 * claude-loop.test.js — verifies tool-use loop termination, cost recording,
 * and budget kill paths via an injected fake Anthropic client.
 *
 * No live API calls; the SDK shape is faithfully imitated by the fake client
 * (messages.create returns content blocks with `type: 'text' | 'tool_use'`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { runClaudeLoop } from '../src/claude-client.js'

class FakeAnthropic {
  /**
   * @param {Array<object>} scriptedResponses — responses returned in order
   */
  constructor(scriptedResponses) {
    this.scripted = [...scriptedResponses]
    this.calls = []
    this.messages = {
      create: async (req) => {
        this.calls.push(req)
        if (this.scripted.length === 0) {
          throw new Error('FakeAnthropic: out of scripted responses')
        }
        return this.scripted.shift()
      },
    }
  }
}

class TestBudget {
  constructor(capCents) {
    this.capCents = capCents
    this.spent = 0
  }
  add(cents) {
    this.spent += cents
    return this.spent <= this.capCents
  }
}

let tmpRoot

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-test-'))
})
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('runClaudeLoop', () => {
  it('terminates on stop_reason=end_turn and records token usage + cost', async () => {
    const fake = new FakeAnthropic([
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 200 },
        content: [{ type: 'text', text: 'all done' }],
      },
    ])
    const budget = new TestBudget(10_000)
    const emitted = []
    const result = await runClaudeLoop({
      apiKey: 'test',
      persona: 'engineer-sr',
      systemPrompt: 'sys',
      userPrompt: 'do work',
      worktreeRoot: tmpRoot,
      budget,
      emit: (l) => emitted.push(l),
      clientFactory: () => fake,
    })

    expect(result.stopReason).toBe('end_turn')
    expect(result.killedReason).toBe(null)
    expect(result.turns).toBe(1)
    expect(result.promptTokens).toBe(1000)
    expect(result.outputTokens).toBe(200)
    // sonnet: 1000*3/1M + 200*15/1M = 0.003 + 0.003 = 0.006 USD = 1 cent (rounded)
    expect(result.totalCostCents).toBe(1)
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(emitted.find((l) => l.type === 'result')?.subtype).toBe('success')
  })

  it('executes tool calls, appends results, and loops until end_turn', async () => {
    const fake = new FakeAnthropic([
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'file_write',
            input: { path: 'src/widget.js', contents: 'export const x = 1\n' },
          },
        ],
      },
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 30 },
        content: [{ type: 'text', text: 'wrote file' }],
      },
    ])
    const result = await runClaudeLoop({
      apiKey: 'test',
      persona: 'engineer-jr',
      systemPrompt: 'sys',
      userPrompt: 'write a widget',
      worktreeRoot: tmpRoot,
      budget: new TestBudget(10_000),
      clientFactory: () => fake,
      emit: () => {},
    })
    expect(result.turns).toBe(2)
    expect(result.stopReason).toBe('end_turn')
    const written = await fs.readFile(path.join(tmpRoot, 'src/widget.js'), 'utf8')
    expect(written).toBe('export const x = 1\n')
  })

  it('terminates at max_turns even if model keeps requesting tools', async () => {
    const stuck = {
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 'tu_x',
          name: 'file_read',
          input: { path: 'nonexistent.txt' },
        },
      ],
    }
    const fake = new FakeAnthropic(Array(10).fill(0).map(() => ({ ...stuck })))
    const result = await runClaudeLoop({
      apiKey: 'test',
      persona: 'engineer-sr',
      systemPrompt: 'sys',
      userPrompt: 'loop forever',
      worktreeRoot: tmpRoot,
      budget: new TestBudget(1_000_000),
      maxTurns: 5,
      clientFactory: () => fake,
      emit: () => {},
    })
    expect(result.turns).toBe(5)
    expect(result.stopReason).toBe('max_turns')
  })

  it('kills the loop when BudgetTracker rejects', async () => {
    const fake = new FakeAnthropic([
      {
        stop_reason: 'tool_use',
        // opus: 1M*15/1M + 1M*75/1M = 90 USD = 9000 cents
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'file_read', input: { path: 'README.md' } },
        ],
      },
    ])
    const budget = new TestBudget(100) // $1 cap
    const result = await runClaudeLoop({
      apiKey: 'test',
      persona: 'engineer-principal',
      systemPrompt: 'sys',
      userPrompt: 'expensive turn',
      worktreeRoot: tmpRoot,
      budget,
      clientFactory: () => fake,
      emit: () => {},
    })
    expect(result.killedReason).toBe('budget')
    expect(result.totalCostCents).toBeGreaterThan(100)
  })

  it('invokes onTurnUsage after each turn with per-turn cost', async () => {
    const fake = new FakeAnthropic([
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 100 },
        content: [{ type: 'text', text: 'done' }],
      },
    ])
    const usageRecords = []
    await runClaudeLoop({
      apiKey: 'test',
      persona: 'qa',
      systemPrompt: 'sys',
      userPrompt: 'verify',
      worktreeRoot: tmpRoot,
      budget: new TestBudget(10_000),
      clientFactory: () => fake,
      emit: () => {},
      onTurnUsage: async (u) => usageRecords.push(u),
    })
    expect(usageRecords).toHaveLength(1)
    expect(usageRecords[0].inputTokens).toBe(500)
    expect(usageRecords[0].outputTokens).toBe(100)
    expect(usageRecords[0].model).toBe('claude-sonnet-4-6')
    expect(typeof usageRecords[0].costCents).toBe('number')
  })
})
