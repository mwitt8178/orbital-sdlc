/**
 * Unit tests: replay/player.ts — Player.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Verifies:
 *   - inspect mode: returns recorded request/response, replay_response is null
 *   - replay-substituted: byte-identical hash → matched_hash=true
 *   - replay-live with executor that returns same response → matched_hash=true
 *   - replay-live with executor that returns drifted response → matched_hash=false
 *
 * Uses a fake DB that returns a known row, and a fake EventStore.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { Player } from '../../../src/replay/player.js'
import { FileSystemStore } from '../../../src/replay/store.js'
import type { CaptureBody } from '../../../src/replay/types.js'
import type { EventInput } from '@orbital/types'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-player-${process.pid}-${Date.now()}`)

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

function makeFakeEventStore() {
  const events: EventInput[] = []
  return {
    events,
    append: async (ev: EventInput) => {
      events.push(ev)
      return { ...ev, event_id: 'fake', ingested_at: new Date().toISOString() } as never
    },
    query: async () => ({ items: [], total: 0, has_more: false }) as never,
    subscribe: () => () => {},
  } as unknown as import('../../../src/events/store.js').EventStore & { events: EventInput[] }
}

interface FakeReplayRow {
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

function makeFakeDB(rowToReturn: FakeReplayRow | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (rowToReturn ? [rowToReturn] : []),
        }),
      }),
    }),
  } as unknown as import('../../../src/db/client.js').DB
}

describe('Player', () => {
  it('inspect mode returns recorded data and null replay_response', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test' })
    const captureId = uuidv7()
    const body: CaptureBody = {
      capture_id: captureId,
      capture_kind: 'llm_request',
      occurred_at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      worker_id: null,
      task_id: null,
      event_id: null,
      request: { prompt: 'hello' },
      response: { content: 'world' },
    }
    const put = await store.put(captureId, body)

    const fakeRow: FakeReplayRow = {
      captureId,
      occurredAt: body.occurred_at,
      workerId: null,
      taskId: null,
      eventId: null,
      captureKind: 'llm_request',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      requestHash: put.request_hash,
      responseHash: put.response_hash,
      storageUri: put.storage_uri,
      sizeBytes: put.size_bytes,
      schemaVersion: 1,
    }

    const player = new Player({
      db: makeFakeDB(fakeRow),
      eventStore: makeFakeEventStore(),
      store,
    })

    const result = await player.replay(captureId, 'inspect')
    expect(result.mode).toBe('inspect')
    expect(result.recorded_request).toEqual(body.request)
    expect(result.recorded_response).toEqual(body.response)
    expect(result.replay_response).toBeNull()
    expect(result.matched_hash).toBe(true)
  })

  it('replay-substituted produces byte-identical response hash', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test' })
    const captureId = uuidv7()
    const body: CaptureBody = {
      capture_id: captureId,
      capture_kind: 'llm_request',
      occurred_at: new Date().toISOString(),
      worker_id: null,
      task_id: null,
      event_id: null,
      request: { prompt: 'add 1+1' },
      response: { content: '2' },
    }
    const put = await store.put(captureId, body)

    const fakeRow: FakeReplayRow = {
      captureId,
      occurredAt: body.occurred_at,
      workerId: null,
      taskId: null,
      eventId: null,
      captureKind: 'llm_request',
      provider: null,
      model: null,
      requestHash: put.request_hash,
      responseHash: put.response_hash,
      storageUri: put.storage_uri,
      sizeBytes: put.size_bytes,
      schemaVersion: 1,
    }

    const player = new Player({
      db: makeFakeDB(fakeRow),
      eventStore: makeFakeEventStore(),
      store,
    })

    const result = await player.replay(captureId, 'replay-substituted')
    expect(result.mode).toBe('replay-substituted')
    expect(result.replay_response).toEqual(body.response)
    expect(result.matched_hash).toBe(true)
  })

  it('replay-live with same response → matched_hash=true; drift → false', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test' })
    const captureId = uuidv7()
    const body: CaptureBody = {
      capture_id: captureId,
      capture_kind: 'llm_request',
      occurred_at: new Date().toISOString(),
      worker_id: null,
      task_id: null,
      event_id: null,
      request: { prompt: 'q' },
      response: { content: 'a' },
    }
    const put = await store.put(captureId, body)

    const fakeRow: FakeReplayRow = {
      captureId,
      occurredAt: body.occurred_at,
      workerId: null,
      taskId: null,
      eventId: null,
      captureKind: 'llm_request',
      provider: null,
      model: null,
      requestHash: put.request_hash,
      responseHash: put.response_hash,
      storageUri: put.storage_uri,
      sizeBytes: put.size_bytes,
      schemaVersion: 1,
    }

    const samePlayer = new Player({
      db: makeFakeDB(fakeRow),
      eventStore: makeFakeEventStore(),
      store,
      liveExecutor: async () => ({ content: 'a' }),
    })
    const sameResult = await samePlayer.replay(captureId, 'replay-live')
    expect(sameResult.matched_hash).toBe(true)

    const driftPlayer = new Player({
      db: makeFakeDB(fakeRow),
      eventStore: makeFakeEventStore(),
      store,
      liveExecutor: async () => ({ content: 'b-drifted' }),
    })
    const driftResult = await driftPlayer.replay(captureId, 'replay-live')
    expect(driftResult.matched_hash).toBe(false)
  })

  it('throws on unknown capture_id', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'unit-test' })
    const player = new Player({
      db: makeFakeDB(null),
      eventStore: makeFakeEventStore(),
      store,
    })
    await expect(player.replay('00000000-0000-0000-0000-000000000000', 'inspect')).rejects.toThrow(
      /REPLAY_NOT_FOUND/,
    )
  })
})
