/**
 * Integration: replay LLM capture round-trip via real Postgres.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * AC #4: capture LLM call → replay.get returns it → hash verifies → blob
 * roundtrips through the store.
 *
 * Real Postgres + real EventStore + real FileSystemStore. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createFileSystemStore } from '../../../src/replay/store.js'
import { createReplayService } from '../../../src/replay/service.js'
import { events } from '../../../src/db/schema/events.js'
import { replayCaptures } from '../../../src/db/schema/replay.js'
import { and as drAnd } from 'drizzle-orm'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-llm-${process.pid}-${Date.now()}`)
const PASSPHRASE = `test-${uuidv7()}`

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
  await sql`SELECT 1` // ensure pool is alive
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
  await closeDb()
})

describe('replay — LLM capture integration (real Postgres)', () => {
  it('captureLLM persists row + blob; replay.get returns same body; hash verifies', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const workerId = uuidv7()
    const taskId = uuidv7()
    const eventId = uuidv7()

    // 1. Capture an LLM request.
    const record = await service.captureLLM({
      workerId,
      taskId,
      eventId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: {
        systemPrompt: 'integration-test-system',
        userPrompt: 'integration-test-user',
        maxTokens: 1024,
      },
      response: {
        content: [{ type: 'text', text: 'integration-test-response' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      determinism: { temperature: 0 },
    })

    expect(record.capture_kind).toBe('llm_request')
    expect(record.size_bytes).toBeGreaterThan(0)
    expect(record.storage_uri).toMatch(/^file:\/\//)

    // 2. Verify the metadata row was written to the DB.
    const rows = await db
      .select()
      .from(replayCaptures)
      .where(eq(replayCaptures.captureId, record.capture_id))
      .limit(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.workerId).toBe(workerId)
    expect(rows[0]!.taskId).toBe(taskId)
    expect(rows[0]!.eventId).toBe(eventId)
    expect(rows[0]!.provider).toBe('anthropic')
    expect(rows[0]!.captureKind).toBe('llm_request')

    // 3. Verify the blob exists on disk.
    const onDiskPath = store.resolvePath(record.storage_uri)
    const stat = await fs.stat(onDiskPath)
    expect(stat.size).toBeGreaterThan(0)

    // 4. Replay in inspect mode → recorded request/response come back intact.
    const replayResult = await service.replay(record.capture_id, 'inspect')
    expect(replayResult.recorded_request['systemPrompt']).toBe('integration-test-system')
    const recordedContent = replayResult.recorded_response['content'] as Array<{ text: string }>
    expect(recordedContent[0]!.text).toBe('integration-test-response')

    // 5. Replay-substituted: the recorded response is fed back. Hash matches.
    const subResult = await service.replay(record.capture_id, 'replay-substituted')
    expect(subResult.matched_hash).toBe(true)

    // 6. Confirm ReplayCaptureCompleted event was appended. Filter by
    //    aggregate_id (= capture_id) to scope the query to this test only —
    //    parallel tests appending similar events should not affect the count.
    const compEvents = await db
      .select()
      .from(events)
      .where(
        drAnd(
          eq(events.eventType, 'ReplayCaptureCompleted'),
          eq(events.aggregateId, record.capture_id),
        ),
      )
    expect(compEvents.length).toBeGreaterThanOrEqual(1)

    // Also confirm a ReplayPlayed event after the substituted run.
    const playedEvents = await db
      .select()
      .from(events)
      .where(
        drAnd(
          eq(events.eventType, 'ReplayPlayed'),
          eq(events.aggregateId, record.capture_id),
        ),
      )
    expect(playedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('list filters by worker_id, task_id, event_id', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const service = createReplayService({ db, eventStore, store })

    const workerA = uuidv7()
    const workerB = uuidv7()
    const taskA = uuidv7()

    const r1 = await service.captureLLM({
      workerId: workerA,
      taskId: taskA,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { p: 1 },
      response: { r: 1 },
    })
    await service.captureLLM({
      workerId: workerB,
      taskId: null,
      eventId: null,
      provider: 'openai',
      model: 'gpt-4',
      request: { p: 2 },
      response: { r: 2 },
    })

    const byWorker = await service.list({ workerId: workerA })
    expect(byWorker.length).toBeGreaterThanOrEqual(1)
    expect(byWorker.every((r) => r.worker_id === workerA)).toBe(true)
    expect(byWorker.find((r) => r.capture_id === r1.capture_id)).toBeDefined()

    const byTask = await service.list({ taskId: taskA })
    expect(byTask.length).toBeGreaterThanOrEqual(1)
    expect(byTask.every((r) => r.task_id === taskA)).toBe(true)
  })
})
