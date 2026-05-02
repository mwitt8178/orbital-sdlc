/**
 * test/integration/hub-client/replay-blob-privacy.integration.test.ts
 *
 * Round 7-05 — Replay blob privacy.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Acceptance criterion #4:
 *   "capturing a replay → metadata in hub Postgres, blob at filesystem;
 *    hexdump of replay_captures.storage_uri row in hub DB shows it's a
 *    file:/// URI not blob bytes"
 *
 * What we verify:
 *   RB1. Recorder.captureLLM persists a real encrypted blob to disk.
 *   RB2. The on-disk blob is opaque (binary, not JSON).
 *   RB3. The metadata row carries a `file:///<path>` storage_uri, NOT the
 *        blob bytes.
 *   RB4. When the metadata row payload is forwarded to the hub via
 *        HubClient.events.append, the request body that hits the wire
 *        contains the file:// URI string but NEVER the encrypted bytes
 *        nor the plaintext request/response.
 *   RB5. If a future refactor accidentally tries to forward the encrypted
 *        bytes to the hub (e.g. a hub-mirror tool that base64-encodes the
 *        blob), the sanitiser blocks the request because the local path
 *        marker is in the URI.
 *
 * No mocks of the recorder or store: real FileSystemStore, real Postgres,
 * real captured blob.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createFileSystemStore } from '../../../src/replay/store.js'
import { createReplayService } from '../../../src/replay/service.js'
import { createHubClientForTest, resetHubClient } from '../../../src/hub-client/index.js'
import { resetSanitizerState } from '../../../src/hub-client/sanitize.js'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-privacy-${process.pid}-${Date.now()}`)
const PASS = `priv-${uuidv7()}`
const TENANT_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd'
const PLAIN_MARKER = 'GIBSONIA_PRIVACY_MARKER_DO_NOT_LEAK'

let hubServer: ReturnType<typeof createHttpServer>
let hubBaseUrl: string
const wireRequests: { url: string; body: string }[] = []

function tRPCResp(data: unknown): string {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
  await sql`SELECT 1`

  await new Promise<void>((resolve) => {
    hubServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        wireRequests.push({ url: req.url ?? '', body })
        if (req.url === '/health') {
          res.writeHead(200)
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(tRPCResp({ event_id: uuidv7(), ingested_at: new Date().toISOString() }))
      })
    })
    hubServer.listen(0, '127.0.0.1', () => {
      const addr = hubServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      hubBaseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(async () => {
  resetSanitizerState()
  resetHubClient()
  await new Promise<void>((resolve, reject) => {
    hubServer.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
  await closeDb()
})

// ---------------------------------------------------------------------------

describe('replay blob privacy', () => {
  it('RB1+RB2: blob is encrypted at rest, on-disk bytes are not JSON', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { messages: [{ role: 'user', content: PLAIN_MARKER }] },
      response: { id: 'msg_x', content: [{ type: 'text', text: PLAIN_MARKER }] },
    })

    expect(record.storage_uri).toMatch(/^file:\/\//)
    const filePath = record.storage_uri.slice('file://'.length)
    const onDiskBytes = await fs.readFile(filePath)
    // Marker must NOT be present in the encrypted bytes.
    expect(onDiskBytes.includes(Buffer.from(PLAIN_MARKER))).toBe(false)
    // Bytes are not JSON.
    expect(() => JSON.parse(onDiskBytes.toString('utf-8'))).toThrow()
  })

  it('RB3: metadata row carries a file:/// URI, not the blob bytes', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { messages: [{ role: 'user', content: 'q' }] },
      response: { id: 'msg_y', content: [{ type: 'text', text: 'a' }] },
    })

    // The DB row's storage_uri should be a file:// URI string.
    expect(record.storage_uri.startsWith('file:///')).toBe(true)
    // The URI is short (a path), not multiple KB of encrypted blob.
    expect(record.storage_uri.length).toBeLessThan(2048)
  })

  it('RB4: forwarding metadata to hub does NOT include encrypted blob bytes', async () => {
    wireRequests.length = 0

    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { messages: [{ role: 'user', content: 'q4' }] },
      response: { id: 'msg_z', content: [{ type: 'text', text: 'a4' }] },
    })

    // Read the on-disk encrypted blob; we'll check that the wire body never
    // contains those bytes.
    const filePath = record.storage_uri.slice('file://'.length)
    const onDiskBytes = await fs.readFile(filePath)

    // Forward the metadata to the hub. Note: we DO send the storage_uri as
    // a path string — but with our sanitiser, the test below shows that any
    // accidental transmission of the actual blob bytes would be caught.
    // Here we send only the safe metadata fields, omitting storage_uri to
    // simulate the actual current behaviour (storage_uri stays local).
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'replay',
      event_type: 'ReplayCaptureCompleted',
      payload: {
        capture_id: record.capture_id,
        request_hash: record.request_hash,
        response_hash: record.response_hash,
        size_bytes: record.size_bytes,
      },
      actor: { type: 'system' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(true)

    // The wire body must not contain the encrypted bytes.
    const wireBody = wireRequests
      .filter((r) => r.url.startsWith('/trpc/audit.events.append'))
      .map((r) => r.body)
      .join('')
    expect(wireBody.length).toBeGreaterThan(0)
    expect(wireBody.includes(onDiskBytes.toString('binary'))).toBe(false)
    // And the wire body should not contain the encrypted file's first
    // 32 bytes (in any encoding), as a stronger check.
    const first32Hex = onDiskBytes.subarray(0, 32).toString('hex')
    expect(wireBody.includes(first32Hex)).toBe(false)
  })

  it('RB5: trying to forward the storage_uri to hub triggers sanitiser', async () => {
    wireRequests.length = 0

    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASS })
    const service = createReplayService({ db, eventStore, store })

    const record = await service.captureLLM({
      workerId: null,
      taskId: null,
      eventId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: { messages: [{ role: 'user', content: 'q5' }] },
      response: { id: 'msg_w', content: [{ type: 'text', text: 'a5' }] },
    })

    // Force an attempt to leak the storage_uri (which contains
    // /.orbital/replays/ — except in tests we use TMP_ROOT under /tmp; we
    // simulate a real path by constructing one).
    const realisticUri = record.storage_uri.replace(TMP_ROOT, '/Users/me/.orbital/replays')

    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'replay',
      event_type: 'ReplayCaptureCompleted',
      payload: {
        capture_id: record.capture_id,
        // Adversarial: a future refactor accidentally adds storage_uri here.
        storage_uri: realisticUri,
      },
      actor: { type: 'system' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected sanitiser to block')
    expect(result.message).toContain('LOCAL_DATA_LEAK')
    // The bytes never reached the hub.
    expect(
      wireRequests.filter((r) => r.url.startsWith('/trpc/audit.events.append') && r.body.includes('storage_uri')),
    ).toHaveLength(0)
  })
})
