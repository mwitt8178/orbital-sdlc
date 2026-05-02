/**
 * store-s3.test.ts — Unit tests for S3Store replay blob driver.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * TDD: written RED before S3Store existed; turned GREEN after implementation.
 *
 * Strategy:
 *   - We mock @aws-sdk/client-s3 at the module level using vitest's vi.mock.
 *   - No real S3 calls — tests run without AWS credentials.
 *   - Verify:
 *       - put() calls PutObjectCommand with correct SSEKMSKeyId and ServerSideEncryption
 *       - put() returns storage_uri, size_bytes, request_hash, response_hash
 *       - get() roundtrips a body unchanged (payload sha256 mode)
 *       - get() roundtrips a body (requestHash/responseHash mode)
 *       - get() throws ReplayCorruptError on sha256 mismatch
 *       - get() throws ReplayCorruptError on request_hash mismatch
 *       - get() throws ReplayCorruptError on response_hash mismatch
 *       - get() throws ReplayCorruptError when S3 returns corrupt JSON
 *       - resolvePath() returns the URI for s3:// URIs
 *       - resolvePath() throws for non-s3:// URIs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { S3Store } from '../../../src/replay/store-s3.js'
import { ReplayCorruptError } from '../../../src/replay/store.js'
import type { CaptureBody } from '../../../src/replay/types.js'
import { uuidv7 } from 'uuidv7'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function makeBody(captureId: string): CaptureBody {
  return {
    capture_id: captureId,
    capture_kind: 'llm_request',
    occurred_at: '2025-05-02T12:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    worker_id: null,
    task_id: null,
    event_id: null,
    request: {
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    },
    response: {
      content: [{ type: 'text', text: 'Hi there!' }],
      usage: { input_tokens: 8, output_tokens: 3 },
    },
    determinism: { temperature: 0 },
  }
}

/**
 * Build a readable stream from a Buffer.
 */
function bufferToReadable(buf: Buffer): Readable {
  const readable = new Readable()
  readable.push(buf)
  readable.push(null)
  return readable
}

// ---------------------------------------------------------------------------
// Mock S3Client
// ---------------------------------------------------------------------------

// We use manual mocks so we can control per-test S3 responses.
function makeMockS3(options?: {
  getObjectBody?: Buffer
  putObjectError?: Error
  getObjectError?: Error
}) {
  const putSpy = vi.fn().mockResolvedValue({})
  const getSpy = vi.fn()

  if (options?.putObjectError) {
    putSpy.mockRejectedValue(options.putObjectError)
  }

  if (options?.getObjectError) {
    // Create a new rejection on each call
    getSpy.mockImplementation(() => Promise.reject(options.getObjectError))
  } else {
    const body = options?.getObjectBody ?? Buffer.alloc(0)
    // Return a fresh Readable stream on every call — streams are consumed after first read
    getSpy.mockImplementation(() => Promise.resolve({ Body: bufferToReadable(body) }))
  }

  const mockS3 = {
    send: vi.fn().mockImplementation((command: unknown) => {
      const cmd = command as { constructor: { name: string } }
      if (cmd.constructor.name === 'PutObjectCommand') {
        return putSpy(command)
      }
      if (cmd.constructor.name === 'GetObjectCommand') {
        return getSpy(command)
      }
      throw new Error(`Unexpected S3 command: ${cmd.constructor.name}`)
    }),
    _putSpy: putSpy,
    _getSpy: getSpy,
  }
  return mockS3
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_BUCKET = 'orbital-replays-mwitt-123456789012'
const TEST_TENANT_ID = '11111111-1111-7111-a111-111111111111'
const TEST_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/test-key-id'

const kmsKeyArnFor = async (_tenantId: string): Promise<string> => TEST_KMS_KEY_ARN

// ---------------------------------------------------------------------------
// put() tests
// ---------------------------------------------------------------------------

describe('S3Store — put()', () => {
  it('returns storage_uri with correct s3:// scheme and tenant partitioning', async () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()
    const body = makeBody(captureId)

    const result = await store.put(captureId, body, TEST_TENANT_ID)

    expect(result.storage_uri).toMatch(
      new RegExp(`^s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}\\.bin$`),
    )
  })

  it('returns correct size_bytes equal to payload buffer length', async () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()
    const body = makeBody(captureId)

    const result = await store.put(captureId, body, TEST_TENANT_ID)

    const expected = Buffer.from(JSON.stringify(body), 'utf-8').length
    expect(result.size_bytes).toBe(expected)
  })

  it('returns sha256-hex request_hash and response_hash', async () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()
    const body = makeBody(captureId)

    const result = await store.put(captureId, body, TEST_TENANT_ID)

    expect(result.request_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.response_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('calls S3 PutObjectCommand with ServerSideEncryption: aws:kms and SSEKMSKeyId', async () => {
    let capturedInput: Record<string, unknown> | null = null
    const mockS3 = {
      send: vi.fn().mockImplementation((command: unknown) => {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
        capturedInput = cmd.input
        return Promise.resolve({})
      }),
    }

    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()
    const body = makeBody(captureId)

    await store.put(captureId, body, TEST_TENANT_ID)

    expect(capturedInput).not.toBeNull()
    expect(capturedInput!['ServerSideEncryption']).toBe('aws:kms')
    expect(capturedInput!['SSEKMSKeyId']).toBe(TEST_KMS_KEY_ARN)
  })

  it('resolves the KMS key ARN via kmsKeyArnFor with the correct tenantId', async () => {
    const kmsResolver = vi.fn().mockResolvedValue(TEST_KMS_KEY_ARN)
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsResolver)
    const captureId = uuidv7()
    const body = makeBody(captureId)

    await store.put(captureId, body, TEST_TENANT_ID)

    expect(kmsResolver).toHaveBeenCalledWith(TEST_TENANT_ID)
  })

  it('includes sha256 of payload in S3 object metadata', async () => {
    let capturedInput: Record<string, unknown> | null = null
    const mockS3 = {
      send: vi.fn().mockImplementation((command: unknown) => {
        const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
        capturedInput = cmd.input
        return Promise.resolve({})
      }),
    }

    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const expectedPayload = Buffer.from(JSON.stringify(body), 'utf-8')
    const expectedSha256 = sha256Hex(expectedPayload)

    await store.put(captureId, body, TEST_TENANT_ID)

    const metadata = capturedInput!['Metadata'] as Record<string, string>
    expect(metadata['sha256']).toBe(expectedSha256)
  })

  it('propagates S3 PutObject errors', async () => {
    const putError = new Error('S3 PutObject throttled')
    const mockS3 = makeMockS3({ putObjectError: putError })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const captureId = uuidv7()

    await expect(store.put(captureId, makeBody(captureId), TEST_TENANT_ID)).rejects.toThrow(
      'S3 PutObject throttled',
    )
  })
})

// ---------------------------------------------------------------------------
// get() tests — payload sha256 mode
// ---------------------------------------------------------------------------

describe('S3Store — get() with payload sha256', () => {
  it('roundtrips a body: put then get returns the same payload', async () => {
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const payload = Buffer.from(JSON.stringify(body), 'utf-8')
    const payloadSha256 = sha256Hex(payload)

    // put() will write this payload; get() mock returns it
    const mockS3 = makeMockS3({ getObjectBody: payload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`
    const got = await store.get(storageUri, payloadSha256)

    expect(got.capture_id).toBe(captureId)
    expect(got.request).toEqual(body.request)
    expect(got.response).toEqual(body.response)
  })

  it('throws ReplayCorruptError when sha256 does not match', async () => {
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const payload = Buffer.from(JSON.stringify(body), 'utf-8')

    const mockS3 = makeMockS3({ getObjectBody: payload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`
    const wrongSha256 = '0'.repeat(64)

    const err = await store.get(storageUri, wrongSha256).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplayCorruptError)
    expect((err as ReplayCorruptError).message).toContain('REPLAY_BLOB_CORRUPT')
  })

  it('throws ReplayCorruptError when S3 object is corrupted JSON', async () => {
    const captureId = uuidv7()
    // Corrupt payload: valid bytes but not parseable as CaptureBody JSON
    const corruptPayload = Buffer.from('not-valid-json-at-all!!##', 'utf-8')
    const corruptSha256 = sha256Hex(corruptPayload) // hash matches, JSON parse fails

    const mockS3 = makeMockS3({ getObjectBody: corruptPayload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`

    await expect(store.get(storageUri, corruptSha256)).rejects.toBeInstanceOf(ReplayCorruptError)
  })

  it('throws ReplayCorruptError when S3 GetObject fails', async () => {
    const captureId = uuidv7()
    const getError = new Error('S3 GetObject access denied')
    const mockS3 = makeMockS3({ getObjectError: getError })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`

    await expect(store.get(storageUri, 'a'.repeat(64))).rejects.toBeInstanceOf(ReplayCorruptError)
    await expect(store.get(storageUri, 'a'.repeat(64))).rejects.toThrow('S3 GetObject failed')
  })
})

// ---------------------------------------------------------------------------
// get() tests — requestHash/responseHash mode (FileSystemStore-compatible)
// ---------------------------------------------------------------------------

describe('S3Store — get() with requestHash + responseHash', () => {
  function canonicalJSON(value: unknown): string {
    return JSON.stringify(value, sortedReplacer)
  }

  function sortedReplacer(_key: string, val: unknown): unknown {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
    const obj = val as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = obj[k]
        return acc
      }, {})
  }

  it('roundtrips with request/response hash verification', async () => {
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const payload = Buffer.from(JSON.stringify(body), 'utf-8')

    const requestHash = sha256Hex(Buffer.from(canonicalJSON(body.request), 'utf-8'))
    const responseHash = sha256Hex(Buffer.from(canonicalJSON(body.response), 'utf-8'))

    const mockS3 = makeMockS3({ getObjectBody: payload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`
    const got = await store.get(storageUri, requestHash, responseHash)

    expect(got.capture_id).toBe(captureId)
  })

  it('throws ReplayCorruptError on request_hash mismatch', async () => {
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const payload = Buffer.from(JSON.stringify(body), 'utf-8')
    const responseHash = sha256Hex(Buffer.from(canonicalJSON(body.response), 'utf-8'))

    const mockS3 = makeMockS3({ getObjectBody: payload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`
    const wrongRequestHash = 'deadbeef'.repeat(8)

    const err = await store.get(storageUri, wrongRequestHash, responseHash).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplayCorruptError)
    expect((err as ReplayCorruptError).message).toContain('REPLAY_BLOB_CORRUPT')
  })

  it('throws ReplayCorruptError on response_hash mismatch', async () => {
    const captureId = uuidv7()
    const body = makeBody(captureId)
    const payload = Buffer.from(JSON.stringify(body), 'utf-8')
    const requestHash = sha256Hex(Buffer.from(canonicalJSON(body.request), 'utf-8'))

    const mockS3 = makeMockS3({ getObjectBody: payload })
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    const storageUri = `s3://${TEST_BUCKET}/${TEST_TENANT_ID}/2025-05-02/${captureId}.bin`
    const wrongResponseHash = 'cafebabe'.repeat(8)

    const err = await store.get(storageUri, requestHash, wrongResponseHash).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplayCorruptError)
    expect((err as ReplayCorruptError).message).toContain('REPLAY_BLOB_CORRUPT')
  })
})

// ---------------------------------------------------------------------------
// resolvePath() tests
// ---------------------------------------------------------------------------

describe('S3Store — resolvePath()', () => {
  it('returns the URI as-is for s3:// URIs', () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    const uri = `s3://${TEST_BUCKET}/tenant/2025-05-02/cap.bin`
    expect(store.resolvePath(uri)).toBe(uri)
  })

  it('throws for non-s3:// URIs', () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)
    expect(() => store.resolvePath('file:///tmp/something.bin')).toThrow(
      'S3Store.resolvePath: unsupported URI scheme',
    )
  })
})

// ---------------------------------------------------------------------------
// parseS3Uri edge cases (exercised through get())
// ---------------------------------------------------------------------------

describe('S3Store — URI parsing edge cases', () => {
  it('throws ReplayCorruptError for non-s3 URI passed to get()', async () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    await expect(store.get('file:///tmp/blob.bin', 'a'.repeat(64))).rejects.toBeInstanceOf(
      ReplayCorruptError,
    )
  })

  it('throws ReplayCorruptError for malformed s3 URI (no key)', async () => {
    const mockS3 = makeMockS3()
    const store = new S3Store(mockS3 as never, TEST_BUCKET, kmsKeyArnFor)

    // No slash after bucket — no key component
    await expect(store.get('s3://bucket-only', 'a'.repeat(64))).rejects.toBeInstanceOf(
      ReplayCorruptError,
    )
  })
})
