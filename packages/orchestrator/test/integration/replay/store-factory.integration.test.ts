/**
 * store-factory.integration.test.ts — Integration tests for createReplayStore factory.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * TDD: written RED before createReplayStore existed; turned GREEN after implementation.
 *
 * Verifies:
 *   - ORBITAL_DEPLOY_TARGET=aws returns an S3Store instance
 *   - ORBITAL_DEPLOY_TARGET=local returns a FileSystemStore instance
 *   - ORBITAL_DEPLOY_TARGET unset returns a FileSystemStore instance (default)
 *   - Missing ORBITAL_REPLAY_BUCKET when ORBITAL_DEPLOY_TARGET=aws throws
 *   - Missing ORBITAL_REPLAY_KMS_KEY_ARN when ORBITAL_DEPLOY_TARGET=aws throws
 *   - Missing rootDir when ORBITAL_DEPLOY_TARGET=local throws
 *   - Missing encryptionPassphrase when ORBITAL_DEPLOY_TARGET=local throws
 *
 * Note: We do NOT mock @aws-sdk/client-s3 here — we only verify the factory
 * returns the correct class type. No S3 calls are made in these tests.
 * The S3Store constructor itself does not make any S3 calls.
 */

import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { createReplayStore, FileSystemStore } from '../../../src/replay/store.js'
import { S3Store } from '../../../src/replay/store-s3.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `orbital-factory-test-${process.pid}`)
const PASSPHRASE = 'factory-test-passphrase-0987654321'
const TEST_BUCKET = 'orbital-replays-mwitt-123456789012'
const TEST_KMS_ARN = 'arn:aws:kms:us-east-1:123456789012:key/test-key-id'

// ---------------------------------------------------------------------------
// S3Store selection
// ---------------------------------------------------------------------------

describe('createReplayStore — aws target', () => {
  it('returns S3Store when ORBITAL_DEPLOY_TARGET=aws', () => {
    const store = createReplayStore({
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_REPLAY_BUCKET: TEST_BUCKET,
      ORBITAL_REPLAY_KMS_KEY_ARN: TEST_KMS_ARN,
      AWS_REGION: 'us-east-1',
    })
    expect(store).toBeInstanceOf(S3Store)
  })

  it('S3Store instance has correct bucket bound', () => {
    const store = createReplayStore({
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_REPLAY_BUCKET: TEST_BUCKET,
      ORBITAL_REPLAY_KMS_KEY_ARN: TEST_KMS_ARN,
      AWS_REGION: 'us-east-1',
    }) as S3Store

    // resolvePath() on s3:// URI should not throw (verifies bucket binding)
    const testUri = `s3://${TEST_BUCKET}/tenant/2025-05-02/test.bin`
    expect(store.resolvePath(testUri)).toBe(testUri)
  })

  it('throws when ORBITAL_REPLAY_BUCKET is missing', () => {
    expect(() =>
      createReplayStore({
        ORBITAL_DEPLOY_TARGET: 'aws',
        ORBITAL_REPLAY_KMS_KEY_ARN: TEST_KMS_ARN,
        AWS_REGION: 'us-east-1',
      }),
    ).toThrow('ORBITAL_REPLAY_BUCKET must be set')
  })

  it('throws when ORBITAL_REPLAY_KMS_KEY_ARN is missing', () => {
    expect(() =>
      createReplayStore({
        ORBITAL_DEPLOY_TARGET: 'aws',
        ORBITAL_REPLAY_BUCKET: TEST_BUCKET,
        AWS_REGION: 'us-east-1',
      }),
    ).toThrow('ORBITAL_REPLAY_KMS_KEY_ARN must be set')
  })
})

// ---------------------------------------------------------------------------
// FileSystemStore selection
// ---------------------------------------------------------------------------

describe('createReplayStore — local target', () => {
  it('returns FileSystemStore when ORBITAL_DEPLOY_TARGET=local', () => {
    const store = createReplayStore(
      { ORBITAL_DEPLOY_TARGET: 'local' },
      { rootDir: TMP_DIR, encryptionPassphrase: PASSPHRASE },
    )
    expect(store).toBeInstanceOf(FileSystemStore)
  })

  it('returns FileSystemStore when ORBITAL_DEPLOY_TARGET is unset (default)', () => {
    const store = createReplayStore(
      {},
      { rootDir: TMP_DIR, encryptionPassphrase: PASSPHRASE },
    )
    expect(store).toBeInstanceOf(FileSystemStore)
  })

  it('throws when rootDir is missing for FileSystemStore', () => {
    expect(() =>
      createReplayStore({ ORBITAL_DEPLOY_TARGET: 'local' }, { encryptionPassphrase: PASSPHRASE }),
    ).toThrow('rootDir is required')
  })

  it('throws when encryptionPassphrase is missing for FileSystemStore', () => {
    expect(() =>
      createReplayStore({ ORBITAL_DEPLOY_TARGET: 'local' }, { rootDir: TMP_DIR }),
    ).toThrow('encryptionPassphrase is required')
  })

  it('throws when no options provided for FileSystemStore', () => {
    expect(() => createReplayStore({ ORBITAL_DEPLOY_TARGET: 'local' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Type safety — verify return types match ReplayStore interface
// ---------------------------------------------------------------------------

describe('createReplayStore — interface contract', () => {
  it('FileSystemStore implements put, get, resolvePath', () => {
    const store = createReplayStore(
      { ORBITAL_DEPLOY_TARGET: 'local' },
      { rootDir: TMP_DIR, encryptionPassphrase: PASSPHRASE },
    )
    expect(typeof store.put).toBe('function')
    expect(typeof store.get).toBe('function')
    expect(typeof store.resolvePath).toBe('function')
  })

  it('S3Store implements put, get, resolvePath', () => {
    const store = createReplayStore({
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_REPLAY_BUCKET: TEST_BUCKET,
      ORBITAL_REPLAY_KMS_KEY_ARN: TEST_KMS_ARN,
      AWS_REGION: 'us-east-1',
    }) as S3Store
    expect(typeof store.put).toBe('function')
    expect(typeof store.get).toBe('function')
    expect(typeof store.resolvePath).toBe('function')
  })
})
