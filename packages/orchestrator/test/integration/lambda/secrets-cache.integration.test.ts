// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * secrets-cache.integration.test.ts
 *
 * Integration tests for the module-scoped TTL cache around AWS Secrets
 * Manager. These tests inject a fake @aws-sdk/client-secrets-manager client
 * via the __setClientCtorForTests test hook so we don't need to hit real AWS.
 *
 * The fake client mimics the SDK's `client.send(command)` shape and tracks
 * how many times GetSecretValue is invoked. We then assert:
 *   - Cold start fetches from Secrets Manager exactly once.
 *   - Warm invocations within TTL reuse the cached value (call count stays 1).
 *   - After TTL expires, the next getSecrets() refetches (call count = 2).
 *   - Concurrent calls during a fetch share the same Promise (call count
 *     does NOT scale with parallelism).
 *   - Rotation: when the underlying secret changes between fetches, the new
 *     value is observed AFTER the TTL expires.
 *
 * These tests do NOT touch a real AWS account.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  getSecrets,
  __resetForTests,
  __setTtlForTests,
  __setClientCtorForTests,
  __inspectCacheForTests,
  type Secrets,
} from '../../../src/lambda/secrets-cache.js'

// ---------------------------------------------------------------------------
// Fake SecretsManager client — minimal shape compatible with the SDK.
// ---------------------------------------------------------------------------

interface FakeStore {
  [arn: string]: { SecretString: string }
}

interface CallStats {
  total: number
  byArn: Record<string, number>
}

function makeFakeClientCtor(store: FakeStore, stats: CallStats) {
  // Returns a ctor that mimics SecretsManagerClient. The actual SDK client
  // is invoked via `new SecretsManagerClient({ region })` then `.send(cmd)`.
  return class FakeClient {
    constructor(_config?: unknown) {
      // ignore region etc.
    }
    async send(cmd: { input: { SecretId: string } }): Promise<{ SecretString: string }> {
      const arn = cmd.input.SecretId
      stats.total += 1
      stats.byArn[arn] = (stats.byArn[arn] ?? 0) + 1
      const value = store[arn]
      if (!value) {
        const err = new Error(`Fake: secret ${arn} not found`)
        err.name = 'ResourceNotFoundException'
        throw err
      }
      return { SecretString: value.SecretString }
    }
  } as unknown as typeof import('@aws-sdk/client-secrets-manager').SecretsManagerClient
}

// ---------------------------------------------------------------------------
// Standard fixture data
// ---------------------------------------------------------------------------

const DB_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:db-AaBbCc'
const HUB_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:hub-DdEeFf'
const WEBHOOK_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:hook-GgHhIi'
const COGNITO_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:cognito-JjKkLl'

const PUBLIC_KEY_HEX = 'a'.repeat(64)
const PRIVATE_KEY_HEX = 'b'.repeat(64)
const PUBLIC_KEY_HEX_V2 = 'c'.repeat(64)
const PRIVATE_KEY_HEX_V2 = 'd'.repeat(64)

function dbCredsJson(host = 'orbital-mwitt.cluster-XYZ.us-east-1.rds.amazonaws.com'): string {
  return JSON.stringify({
    username: 'orbital_admin',
    password: 'unused-password-for-iam-auth',
    host,
    port: 5432,
    dbname: 'orbital_hub',
    engine: 'postgres',
  })
}

function hubKeyJson(pub = PUBLIC_KEY_HEX, priv = PRIVATE_KEY_HEX): string {
  return JSON.stringify({
    publicKey: pub,
    privateKey: priv,
    generatedAt: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Per-test setup
// ---------------------------------------------------------------------------

let stats: CallStats
let store: FakeStore
let originalEnv: Record<string, string | undefined>

beforeEach(() => {
  __resetForTests()
  stats = { total: 0, byArn: {} }
  store = {
    [DB_ARN]: { SecretString: dbCredsJson() },
    [HUB_KEY_ARN]: { SecretString: hubKeyJson() },
    [WEBHOOK_ARN]: { SecretString: 'a-32-char-webhook-secret-AAAAAAA' },
    [COGNITO_ARN]: { SecretString: 'cognito-client-secret' },
  }
  __setClientCtorForTests(makeFakeClientCtor(store, stats))

  originalEnv = {
    ORBITAL_DB_CREDS_SECRET_ARN: process.env['ORBITAL_DB_CREDS_SECRET_ARN'],
    ORBITAL_HUB_MASTER_KEY_SECRET_ARN: process.env['ORBITAL_HUB_MASTER_KEY_SECRET_ARN'],
    ORBITAL_GITHUB_WEBHOOK_SECRET_ARN: process.env['ORBITAL_GITHUB_WEBHOOK_SECRET_ARN'],
    ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN: process.env['ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN'],
  }
  process.env['ORBITAL_DB_CREDS_SECRET_ARN'] = DB_ARN
  process.env['ORBITAL_HUB_MASTER_KEY_SECRET_ARN'] = HUB_KEY_ARN
  process.env['ORBITAL_GITHUB_WEBHOOK_SECRET_ARN'] = WEBHOOK_ARN
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  __resetForTests()
})

// ---------------------------------------------------------------------------
// Cold start
// ---------------------------------------------------------------------------

describe('secrets-cache — cold start', () => {
  it('fetches all required secrets on first call', async () => {
    const result: Secrets = await getSecrets()
    expect(stats.total).toBe(3) // db + hub + webhook (no cognito)
    expect(stats.byArn[DB_ARN]).toBe(1)
    expect(stats.byArn[HUB_KEY_ARN]).toBe(1)
    expect(stats.byArn[WEBHOOK_ARN]).toBe(1)
    expect(result.db.hostname).toContain('orbital-mwitt')
    expect(result.db.port).toBe(5432)
    expect(result.db.username).toBe('orbital_admin')
    expect(result.db.database).toBe('orbital_hub')
    expect(result.hubMasterKey.publicKey).toBe(PUBLIC_KEY_HEX)
    expect(result.hubMasterKey.privateKey).toBe(PRIVATE_KEY_HEX)
    expect(result.webhookSecret).toBe('a-32-char-webhook-secret-AAAAAAA')
    expect(result.cognitoAppClientSecret).toBeUndefined()
  })

  it('fetches the optional cognito secret when env is set', async () => {
    process.env['ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN'] = COGNITO_ARN
    const result = await getSecrets()
    expect(stats.total).toBe(4)
    expect(result.cognitoAppClientSecret).toBe('cognito-client-secret')
  })

  it('throws clearly when a required env var is missing', async () => {
    delete process.env['ORBITAL_DB_CREDS_SECRET_ARN']
    await expect(getSecrets()).rejects.toThrow(/ORBITAL_DB_CREDS_SECRET_ARN/)
  })

  it('throws clearly when the hub master key is uninitialized', async () => {
    store[HUB_KEY_ARN] = {
      SecretString: JSON.stringify({
        uninitialized: true,
        publicKey: 'PENDING_ROTATION',
        privateKey: 'PENDING_ROTATION',
      }),
    }
    await expect(getSecrets()).rejects.toThrow(/uninitialized/)
  })

  it('rejects malformed hub master keys (wrong hex length)', async () => {
    store[HUB_KEY_ARN] = {
      SecretString: JSON.stringify({
        publicKey: 'shortkey',
        privateKey: 'shortkey',
      }),
    }
    await expect(getSecrets()).rejects.toThrow(/length invalid/)
  })

  it('rejects db creds without hostname', async () => {
    store[DB_ARN] = {
      SecretString: JSON.stringify({ username: 'u', port: 5432, dbname: 'x' }),
    }
    await expect(getSecrets()).rejects.toThrow(/host\/hostname/)
  })
})

// ---------------------------------------------------------------------------
// Warm reuse
// ---------------------------------------------------------------------------

describe('secrets-cache — warm reuse', () => {
  it('returns cached value on second call without re-fetching', async () => {
    await getSecrets()
    expect(stats.total).toBe(3)

    await getSecrets()
    expect(stats.total).toBe(3) // no new fetches

    await getSecrets()
    expect(stats.total).toBe(3) // still 3
  })

  it('inspect cache reports a cached value with non-null age', async () => {
    await getSecrets()
    const snap = __inspectCacheForTests()
    expect(snap.hasValue).toBe(true)
    expect(snap.ageMs).not.toBeNull()
    expect(snap.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('concurrent callers during a fetch share the same Promise (no fan-out)', async () => {
    // Issue 5 concurrent getSecrets() calls. The fake client tracks total
    // calls; we expect 3 (one per ARN), not 15.
    const promises = [getSecrets(), getSecrets(), getSecrets(), getSecrets(), getSecrets()]
    await Promise.all(promises)
    expect(stats.total).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// TTL expiry — rotation observed
// ---------------------------------------------------------------------------

describe('secrets-cache — TTL expiry picks up rotation', () => {
  it('after TTL the next call refetches and observes the new value', async () => {
    // Set a very short TTL so the test does not need to wait.
    __setTtlForTests(50) // 50ms

    const v1 = await getSecrets()
    expect(stats.total).toBe(3)
    expect(v1.hubMasterKey.publicKey).toBe(PUBLIC_KEY_HEX)

    // Simulate a rotation: replace the underlying secret content.
    store[HUB_KEY_ARN] = { SecretString: hubKeyJson(PUBLIC_KEY_HEX_V2, PRIVATE_KEY_HEX_V2) }

    // Wait for TTL to expire.
    await new Promise((resolve) => setTimeout(resolve, 75))

    const v2 = await getSecrets()
    expect(stats.total).toBe(6) // three more fetches
    expect(v2.hubMasterKey.publicKey).toBe(PUBLIC_KEY_HEX_V2)
    expect(v2.hubMasterKey.privateKey).toBe(PRIVATE_KEY_HEX_V2)
  })

  it('within TTL, rotated underlying value is NOT observed (cache wins)', async () => {
    __setTtlForTests(60_000) // 60s — comfortably longer than test runtime

    const v1 = await getSecrets()
    expect(v1.hubMasterKey.publicKey).toBe(PUBLIC_KEY_HEX)

    // Rotate the secret while the cache is still hot.
    store[HUB_KEY_ARN] = { SecretString: hubKeyJson(PUBLIC_KEY_HEX_V2) }

    const v2 = await getSecrets()
    // Cache is still warm — old value returned.
    expect(v2.hubMasterKey.publicKey).toBe(PUBLIC_KEY_HEX)
    expect(stats.total).toBe(3)
  })

  it('__resetForTests forces a refetch on the next call', async () => {
    await getSecrets()
    expect(stats.total).toBe(3)
    __resetForTests()
    // resetting wipes both client + ttl. We need to re-inject the fake.
    __setClientCtorForTests(makeFakeClientCtor(store, stats))
    await getSecrets()
    expect(stats.total).toBe(6)
  })
})
