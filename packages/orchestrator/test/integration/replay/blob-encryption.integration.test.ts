/**
 * Integration: blob on disk is encrypted at rest.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * AC #6 (architecture.md):
 *   "Encryption: blob on disk is unreadable without the install key —
 *    verified via test that opens the file and asserts non-JSON content."
 *
 * Strategy:
 *   1. Capture a payload containing a recognisable plaintext marker.
 *   2. Open the on-disk file directly. Assert:
 *      - The bytes contain neither the marker nor the user prompt.
 *      - The bytes do not parse as JSON.
 *   3. With the wrong passphrase, store.get() throws ReplayCorruptError.
 *   4. With the right passphrase, store.get() roundtrips the body.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createFileSystemStore, ReplayCorruptError, FileSystemStore } from '../../../src/replay/store.js'
import { createReplayService } from '../../../src/replay/service.js'
import { replayCaptures } from '../../../src/db/schema/replay.js'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-blob-enc-${process.pid}-${Date.now()}`)
const RIGHT_PASS = `right-${uuidv7()}`
const WRONG_PASS = `wrong-${uuidv7()}`

const PLAINTEXT_MARKER = 'GIBSONIA_SECRET_MARKER_INTEGRATION_TEST_only'

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
  await sql`SELECT 1`
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
  await closeDb()
})

describe('replay — blob encryption at rest (real Postgres)', () => {
  it('on-disk file is unreadable without the install key', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: RIGHT_PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: {
        systemPrompt: PLAINTEXT_MARKER,
        userPrompt: 'sensitive-user-content',
      },
      response: {
        content: [{ type: 'text', text: 'sensitive-response' }],
      },
    })

    // 1. Resolve the on-disk path from the storage_uri.
    const onDisk = store.resolvePath(record.storage_uri)
    const bytes = await fs.readFile(onDisk)
    const text = bytes.toString('utf-8')

    // 2. Plaintext markers must NOT be visible in the encrypted blob.
    expect(text).not.toContain(PLAINTEXT_MARKER)
    expect(text).not.toContain('sensitive-user-content')
    expect(text).not.toContain('sensitive-response')

    // 3. The bytes must NOT parse as JSON.
    expect(() => JSON.parse(text)).toThrow()

    // 4. With the WRONG passphrase, store.get() throws ReplayCorruptError.
    const wrongStore = new FileSystemStore({
      rootDir: TMP_ROOT,
      encryptionPassphrase: WRONG_PASS,
    })
    await expect(
      wrongStore.get(record.storage_uri, record.request_hash, record.response_hash),
    ).rejects.toBeInstanceOf(ReplayCorruptError)

    // 5. With the right passphrase, the body roundtrips.
    const got = await store.get(record.storage_uri, record.request_hash, record.response_hash)
    expect(got.request['systemPrompt']).toBe(PLAINTEXT_MARKER)
    expect(got.request['userPrompt']).toBe('sensitive-user-content')
  })

  it('size_bytes in the row matches actual on-disk file size', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: RIGHT_PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { p: 'small' },
      response: { r: 'tiny' },
    })

    const stat = await fs.stat(store.resolvePath(record.storage_uri))
    expect(stat.size).toBe(record.size_bytes)

    const dbRow = await db
      .select()
      .from(replayCaptures)
      .where(eq(replayCaptures.captureId, record.capture_id))
      .limit(1)
    expect(dbRow[0]!.sizeBytes).toBe(stat.size)
  })

  it('mode 0600 on the blob file (owner-only read/write)', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: RIGHT_PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { p: 'mode-check' },
      response: { r: 'mode-check' },
    })

    const stat = await fs.stat(store.resolvePath(record.storage_uri))
    // Bottom 9 bits are the unix mode. Expect 0o600 → 0o100600 in S_IFREG OR.
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })
})
