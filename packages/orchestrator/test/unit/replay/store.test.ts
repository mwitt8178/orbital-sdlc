/**
 * Unit tests: replay/store.ts — FileSystemStore.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Verifies:
 *   - put returns storage_uri + size + hashes
 *   - get round-trips a body unchanged
 *   - on-disk file is encrypted (does NOT contain plaintext request strings)
 *   - tampered file → ReplayCorruptError on read (auth-tag mismatch)
 *   - mismatched expected-hash on get → ReplayCorruptError
 *
 * No mocks — uses Node's real filesystem under tmp/.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { FileSystemStore, ReplayCorruptError } from '../../../src/replay/store.js'
import type { CaptureBody } from '../../../src/replay/types.js'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-store-${process.pid}-${Date.now()}`)

const PASSPHRASE = 'unit-test-install-id-0123456789'

function makeBody(captureId: string): CaptureBody {
  return {
    capture_id: captureId,
    capture_kind: 'llm_request',
    occurred_at: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    worker_id: null,
    task_id: null,
    event_id: null,
    request: {
      systemPrompt: 'A_VERY_RECOGNISABLE_PLAINTEXT_MARKER_for_test_only',
      userPrompt: 'hello world',
      maxTokens: 1024,
    },
    response: {
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 1 },
    },
    determinism: { temperature: 0 },
  }
}

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
})

describe('FileSystemStore — put + get', () => {
  it('round-trips a body and returns the same payload', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const put = await store.put(captureId, body)

    expect(put.storage_uri).toMatch(/^file:\/\//)
    expect(put.size_bytes).toBeGreaterThan(0)
    expect(put.request_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(put.response_hash).toMatch(/^[0-9a-f]{64}$/)

    const got = await store.get(put.storage_uri, put.request_hash, put.response_hash)
    expect(got.capture_id).toBe(captureId)
    expect(got.request['systemPrompt']).toBe(body.request['systemPrompt'])
    expect(got.response['content']).toEqual(body.response['content'])
  })

  it('produces an encrypted blob — plaintext markers are absent on disk', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const put = await store.put(captureId, body)
    const onDisk = await fs.readFile(store.resolvePath(put.storage_uri))
    const text = onDisk.toString('utf-8')
    expect(text).not.toContain('A_VERY_RECOGNISABLE_PLAINTEXT_MARKER_for_test_only')
    expect(text).not.toContain('hello world')

    // Stronger: the bytes should not parse as JSON.
    expect(() => JSON.parse(text)).toThrow()
  })

  it('rejects mismatched request_hash with ReplayCorruptError', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const put = await store.put(captureId, body)

    const wrongHash = '0'.repeat(64)
    await expect(store.get(put.storage_uri, wrongHash, put.response_hash)).rejects.toBeInstanceOf(
      ReplayCorruptError,
    )
  })

  it('rejects tampered ciphertext with ReplayCorruptError (auth tag mismatch)', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const put = await store.put(captureId, body)

    // Flip a byte in the middle of the ciphertext.
    const filePath = store.resolvePath(put.storage_uri)
    const buf = await fs.readFile(filePath)
    const idx = Math.floor(buf.length / 2)
    buf[idx] = buf[idx]! ^ 0xff
    await fs.writeFile(filePath, buf)

    await expect(store.get(put.storage_uri, put.request_hash, put.response_hash)).rejects.toBeInstanceOf(
      ReplayCorruptError,
    )
  })

  it('rejects wrong passphrase with ReplayCorruptError', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const put = await store.put(captureId, body)

    const wrongStore = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: 'something-else' })
    await expect(
      wrongStore.get(put.storage_uri, put.request_hash, put.response_hash),
    ).rejects.toBeInstanceOf(ReplayCorruptError)
  })

  it('unique salts → identical content produces distinct ciphertext', async () => {
    const store = new FileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const id1 = uuidv7()
    const id2 = uuidv7()
    const body1 = makeBody(id1)
    const body2 = { ...makeBody(id2), occurred_at: body1.occurred_at }
    body2.request = body1.request
    body2.response = body1.response
    const p1 = await store.put(id1, body1)
    const p2 = await store.put(id2, body2)
    const a = await fs.readFile(store.resolvePath(p1.storage_uri))
    const b = await fs.readFile(store.resolvePath(p2.storage_uri))
    expect(Buffer.compare(a, b)).not.toBe(0)
  })
})
