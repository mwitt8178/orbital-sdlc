// [Engineer-Sr · Sonnet · run-round8-02-aurora]
/**
 * Unit test: DB client IAM auth path — ORBITAL_DEPLOY_TARGET=aws
 *
 * Verifies that when ORBITAL_DEPLOY_TARGET=aws the client calls
 * @aws-sdk/rds-signer to generate a token rather than using DATABASE_URL.
 *
 * Strategy:
 *  - Mock @aws-sdk/rds-signer via vi.mock so no real AWS calls are made.
 *  - Mock postgres so no real DB connection is attempted.
 *  - Set required env vars, call getDb(), assert token generated.
 *  - RED: written before the implementation. GREEN: once client.ts branches on
 *    ORBITAL_DEPLOY_TARGET=aws.
 *
 * [Engineer-Sr · Sonnet · run-round8-02-aurora]
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

// Mock the RDS Signer so no real AWS call is made
const mockGetAuthToken = vi.fn().mockResolvedValue('mock-iam-token-abc123')
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: vi.fn().mockImplementation(() => ({
    getAuthToken: mockGetAuthToken,
  })),
}))

// Mock postgres so no real DB connection is attempted
const mockEnd = vi.fn().mockResolvedValue(undefined)
const mockPostgres = vi.fn().mockReturnValue({
  end: mockEnd,
})
vi.mock('postgres', () => ({ default: mockPostgres }))

// Mock drizzle-orm so it doesn't need a real postgres client
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn().mockReturnValue({ _drizzle: true }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore process.env around each test. */
const originalEnv = { ...process.env }

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

function restoreEnv(): void {
  // Clear all keys that were added
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  // Restore original values
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DB client — IAM auth (ORBITAL_DEPLOY_TARGET=aws)', () => {
  beforeEach(() => {
    // Reset mocks between tests
    vi.clearAllMocks()

    // Set required AWS env vars
    setEnv({
      ORBITAL_DEPLOY_TARGET: 'aws',
      RDS_PROXY_HOSTNAME: 'orbital-mwitt-proxy.proxy-xxxx.us-east-1.rds.amazonaws.com',
      RDS_PROXY_PORT: '5432',
      AURORA_DB_NAME: 'orbital_hub',
      AURORA_USERNAME: 'orbital_admin',
      AWS_REGION: 'us-east-1',
    })
  })

  afterEach(() => {
    restoreEnv()
    // Reset module registry so each test gets a fresh client.ts module state
    vi.resetModules()
  })

  test('getDb() calls Signer with correct parameters when ORBITAL_DEPLOY_TARGET=aws', async () => {
    // Reset env cache and module state so it picks up the new env vars
    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')
    const { Signer } = await import('@aws-sdk/rds-signer')

    await getDb()

    // Verify Signer was constructed with the correct config
    expect(Signer).toHaveBeenCalledWith({
      region: 'us-east-1',
      hostname: 'orbital-mwitt-proxy.proxy-xxxx.us-east-1.rds.amazonaws.com',
      port: 5432,
      username: 'orbital_admin',
    })
  })

  test('getDb() calls getAuthToken() to obtain a short-lived token', async () => {
    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await getDb()

    expect(mockGetAuthToken).toHaveBeenCalledOnce()
  })

  test('getDb() passes the IAM token as the postgres password', async () => {
    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await getDb()

    // postgres() should have been called with the IAM token as password
    expect(mockPostgres).toHaveBeenCalledWith(
      expect.objectContaining({
        password: 'mock-iam-token-abc123',
      }),
    )
  })

  test('getDb() connects to the RDS Proxy hostname (not localhost)', async () => {
    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await getDb()

    expect(mockPostgres).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'orbital-mwitt-proxy.proxy-xxxx.us-east-1.rds.amazonaws.com',
        port: 5432,
        database: 'orbital_hub',
        username: 'orbital_admin',
      }),
    )
  })

  test('getDb() enables SSL (required for RDS Proxy IAM auth)', async () => {
    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await getDb()

    const callArgs = mockPostgres.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArgs).toBeDefined()
    expect(callArgs['ssl']).toBeTruthy()
  })

  test('getDb() does NOT call Signer when ORBITAL_DEPLOY_TARGET is local (default)', async () => {
    // Override: set to local (the default in non-AWS environments)
    setEnv({ ORBITAL_DEPLOY_TARGET: 'local' })

    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    // Re-import client in local mode
    const { getDb } = await import('../../../src/db/client.js')
    const { Signer } = await import('@aws-sdk/rds-signer')

    await getDb()

    // Signer should NOT be called in local/Docker mode
    expect(Signer).not.toHaveBeenCalled()
    expect(mockGetAuthToken).not.toHaveBeenCalled()
  })

  test('getDb() uses DATABASE_URL for postgres in local mode', async () => {
    setEnv({
      ORBITAL_DEPLOY_TARGET: 'local',
      DATABASE_URL: 'postgres://orbital:orbital_dev_password@localhost:5432/orbital',
    })

    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await getDb()

    // In local mode, postgres is called with the DATABASE_URL string
    expect(mockPostgres).toHaveBeenCalledWith(
      'postgres://orbital:orbital_dev_password@localhost:5432/orbital',
      expect.any(Object),
    )
  })

  test('getDb() throws a clear error when RDS_PROXY_HOSTNAME is missing in AWS mode', async () => {
    setEnv({ RDS_PROXY_HOSTNAME: undefined })

    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await expect(getDb()).rejects.toThrow('RDS_PROXY_HOSTNAME')
  })

  test('getDb() throws a clear error when AWS_REGION is missing in AWS mode', async () => {
    setEnv({ AWS_REGION: undefined })

    const { resetEnvCache } = await import('../../../src/config/env.js')
    resetEnvCache()

    const { getDb } = await import('../../../src/db/client.js')

    await expect(getDb()).rejects.toThrow('AWS_REGION')
  })
})
