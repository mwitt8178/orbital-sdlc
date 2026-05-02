/**
 * Integration: replay-substituted produces byte-identical output.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * AC #5 (architecture.md):
 *   "Replay-substituted: re-run a captured agent flow → new output matches
 *    recorded output byte-for-byte (verifies determinism)."
 *
 * Real Postgres + real ReplayService. Persists 3 captures (LLM + tool +
 * hook), replays each in substituted mode, asserts matched_hash=true and
 * the replay_response equals the recorded_response after canonical-JSON
 * comparison.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createFileSystemStore } from '../../../src/replay/store.js'
import { createReplayService } from '../../../src/replay/service.js'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-substituted-${process.pid}-${Date.now()}`)
const PASSPHRASE = `sub-${uuidv7()}`

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
  await sql`SELECT 1`
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
  await closeDb()
})

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const obj = v as Record<string, unknown>
    return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k]
      return acc
    }, {})
  })
}

describe('replay — replay-substituted produces byte-identical output', () => {
  it('LLM capture: substituted run hashes match the original', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const recorded = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: {
        systemPrompt: 'You are a deterministic agent.',
        userPrompt: 'add 2+2',
        maxTokens: 64,
      },
      response: {
        content: [{ type: 'text', text: '4' }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      determinism: { temperature: 0 },
    })

    const result = await service.replay(recorded.capture_id, 'replay-substituted')
    expect(result.matched_hash).toBe(true)
    expect(canonical(result.replay_response)).toBe(canonical(result.recorded_response))
  })

  it('tool capture: substituted run produces an identical envelope', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const recorded = await service.captureTool({
      workerId: null,
      taskId: null,
      eventId: null,
      request: { method: 'fs.read', params: { path: '/tmp/x.txt' } },
      response: { jsonrpc: '2.0', id: 1, result: { content: 'file body' } },
    })

    const result = await service.replay(recorded.capture_id, 'replay-substituted')
    expect(result.matched_hash).toBe(true)
  })

  it('hook capture: substituted run produces an identical decision', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const recorded = await service.captureHook({
      workerId: null,
      taskId: null,
      eventId: null,
      request: { hookId: 'pre-merge', input: { branch: 'feat/x' } },
      response: { decision: 'allow', reason: 'tests passed' },
    })

    const result = await service.replay(recorded.capture_id, 'replay-substituted')
    expect(result.matched_hash).toBe(true)
  })

  it('cross-driver: an OpenAI-shaped capture replays the same as anthropic', async () => {
    // Simulates Wave 1 #8 multi-model paths — the Recorder is provider-agnostic.
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const openaiRec = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'openai',
      model: 'gpt-4',
      request: { messages: [{ role: 'user', content: 'q' }], temperature: 0 },
      response: { id: 'cmpl-fake', choices: [{ message: { content: 'a' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    })

    const anthRec = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { systemPrompt: 's', userPrompt: 'q' },
      response: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 1, output_tokens: 1 } },
    })

    const o = await service.replay(openaiRec.capture_id, 'replay-substituted')
    const a = await service.replay(anthRec.capture_id, 'replay-substituted')
    expect(o.matched_hash).toBe(true)
    expect(a.matched_hash).toBe(true)
  })
})
