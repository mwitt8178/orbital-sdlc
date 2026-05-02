/**
 * Unit tests: replay/recorder.ts — Recorder.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Verifies:
 *   - capture / captureLLM / captureTool route to the same code path with
 *     correct kind tagging
 *   - secrets are redacted from the persisted body before encryption
 *   - the metadata row + audit events fire (verified via in-memory shims)
 *
 * Uses a fake EventStore + a fake DB (with a minimal insert(...).values(...)
 * stub) — these are NOT mocks of production code, they are test-local
 * implementations that satisfy the typed interface.
 *
 * Per CLAUDE.md no-mocks rule: in-test fakes that don't replace production
 * code paths in src/ are acceptable; mocking modules is what is forbidden.
 */

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Recorder } from '../../../src/replay/recorder.js'
import { FileSystemStore } from '../../../src/replay/store.js'
import type { EventInput } from '@orbital/types'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-recorder-${process.pid}-${Date.now()}`)

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

import { beforeAll, afterAll } from 'vitest'

interface FakeEventInput extends EventInput {}

function makeFakeEventStore() {
  const events: FakeEventInput[] = []
  return {
    events,
    append: async (ev: FakeEventInput) => {
      events.push(ev)
      return {
        ...ev,
        event_id: 'fake-' + events.length,
        ingested_at: new Date().toISOString(),
      } as unknown as Awaited<ReturnType<import('../../../src/events/store.js').EventStore['append']>>
    },
    query: async () => ({ items: [], total: 0, has_more: false }) as never,
    subscribe: () => () => {},
  } as unknown as import('../../../src/events/store.js').EventStore & { events: FakeEventInput[] }
}

interface FakeRow {
  captureId: string
  occurredAt: string
  workerId: string | null
  taskId: string | null
  eventId: string | null
  captureKind: string
  provider: string | null
  model: string | null
  requestHash: string
  responseHash: string
  storageUri: string
  sizeBytes: number
  schemaVersion: number
}

function makeFakeDB() {
  const rows: FakeRow[] = []
  const fakeDB = {
    insert: () => ({
      values: async (values: FakeRow) => {
        rows.push(values)
      },
    }),
  } as unknown as import('../../../src/db/client.js').DB
  return { db: fakeDB, rows }
}

describe('Recorder', () => {
  it('captureLLM persists a row + emits started + completed events', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test' })
    const eventStore = makeFakeEventStore()
    const fakeDB = makeFakeDB()

    const recorder = new Recorder({ db: fakeDB.db, eventStore, store })
    const result = await recorder.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { systemPrompt: 'you are a tester' },
      response: { content: [{ type: 'text', text: 'ok' }] },
    })

    expect(result.capture_kind).toBe('llm_request')
    expect(result.provider).toBe('anthropic')
    expect(result.size_bytes).toBeGreaterThan(0)
    expect(result.storage_uri).toMatch(/^file:\/\//)

    expect(fakeDB.rows).toHaveLength(1)
    const row = fakeDB.rows[0]!
    expect(row.captureKind).toBe('llm_request')
    expect(row.provider).toBe('anthropic')

    const eventTypes = eventStore.events.map((e: FakeEventInput) => e.event_type)
    expect(eventTypes).toContain('ReplayCaptureStarted')
    expect(eventTypes).toContain('ReplayCaptureCompleted')
  })

  it('redacts api_key and Authorization headers from the persisted body', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test-2' })
    const eventStore = makeFakeEventStore()
    const fakeDB = makeFakeDB()
    const recorder = new Recorder({ db: fakeDB.db, eventStore, store })

    const result = await recorder.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'openai',
      model: 'gpt-4',
      request: {
        api_key: 'sk-SHOULD-NOT-LEAK-1234',
        headers: { Authorization: 'Bearer SHOULD-NOT-LEAK-5678' },
        prompt: 'hi',
      },
      response: { ok: true },
    })

    // Read back the blob via the store; the request fields should be redacted.
    const got = await store.get(result.storage_uri, result.request_hash, result.response_hash)
    expect(got.request['api_key']).toBe('[REDACTED]')
    const headers = got.request['headers'] as Record<string, unknown>
    expect(headers['Authorization']).toBe('[REDACTED]')
    expect(got.request['prompt']).toBe('hi')
  })

  it('captureTool tags kind=tool_call', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test-3' })
    const eventStore = makeFakeEventStore()
    const fakeDB = makeFakeDB()
    const recorder = new Recorder({ db: fakeDB.db, eventStore, store })

    const result = await recorder.captureTool({
      workerId: null,
      taskId: null,
      eventId: null,
      request: { method: 'fs.readFile', params: { path: '/tmp/foo.txt' } },
      response: { result: { content: 'fake content' } },
    })

    expect(result.capture_kind).toBe('tool_call')
    expect(result.provider).toBeNull()
    expect(result.model).toBeNull()
  })
})
