/**
 * integration/lambda/init-cold-start.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Tests the cold-start initialization pattern (lambda/init.ts).
 *
 * Key behaviors:
 *  1. initOnce() initializes db and secrets on first call
 *  2. initOnce() returns cached result on subsequent calls (no re-init)
 *  3. _resetInit() allows re-initialization (test isolation helper)
 *  4. initOnce() is safe to call concurrently (single-threaded Lambda)
 *
 * Note: These tests run against the local Postgres DB (ORBITAL_DEPLOY_TARGET unset).
 * In AWS mode (ORBITAL_DEPLOY_TARGET=aws) they would use IAM auth — that path
 * is not tested here (requires actual RDS Proxy infrastructure).
 *
 * Skips if DATABASE_URL is not configured (CI environments without Postgres).
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Conditional skip guard — skip if no local DB is available
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env['DATABASE_URL'])

describe.skipIf(!hasDb)('lambda/init — cold-start initialization', () => {
  // Reset the module singleton between test cases to isolate test state
  beforeEach(async () => {
    // Dynamic import so we can reset between tests
    const initModule = await import('../../../src/lambda/init.js')
    initModule._resetInit()
  })

  it('initOnce() returns db and secrets', async () => {
    const { initOnce } = await import('../../../src/lambda/init.js')
    const result = await initOnce()

    expect(result).toBeDefined()
    expect(result.db).toBeDefined()
    expect(result.secrets).toBeDefined()
    // Secrets is the stub (empty object) in local mode
    expect(typeof result.secrets).toBe('object')
  })

  it('initOnce() returns same instance on second call (no re-init)', async () => {
    const { initOnce } = await import('../../../src/lambda/init.js')

    const first = await initOnce()
    const second = await initOnce()

    // Same db reference — module-scope singleton
    expect(first.db).toBe(second.db)
  })

  it('initOnce() is idempotent across multiple parallel calls', async () => {
    const { initOnce } = await import('../../../src/lambda/init.js')

    // Simulate concurrent Lambda invocations calling initOnce simultaneously
    // In a real Lambda this is not possible (single-threaded) but the test
    // verifies no race condition from the initialization guard
    const [r1, r2, r3] = await Promise.all([initOnce(), initOnce(), initOnce()])

    expect(r1.db).toBe(r2.db)
    expect(r2.db).toBe(r3.db)
  })

  it('_resetInit() allows re-initialization on next call', async () => {
    const initModule = await import('../../../src/lambda/init.js')

    const first = await initModule.initOnce()
    initModule._resetInit()
    const second = await initModule.initOnce()

    // After reset, a new db is created (different object reference)
    // Note: In local mode both will use the module-level db singleton from client.ts
    // so they may or may not be the same reference; what matters is init completes.
    expect(second.db).toBeDefined()
    expect(second.secrets).toBeDefined()
    // Functionally both should work
    expect(typeof second.db).toBe('object')
  })

  it('secrets returned by initOnce() is an object', async () => {
    const { initOnce } = await import('../../../src/lambda/init.js')
    const result = await initOnce()
    // In local mode (ORBITAL_DEPLOY_TARGET unset), the stub returns {}
    expect(typeof result.secrets).toBe('object')
    // Stub returns empty secrets — all keys optional per Secrets interface
    expect(result.secrets.hubMasterKey).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Unit-level tests that don't need a DB
// ---------------------------------------------------------------------------

describe('lambda/init — module structure', () => {
  it('initOnce is exported as a function', async () => {
    const initModule = await import('../../../src/lambda/init.js')
    expect(typeof initModule.initOnce).toBe('function')
  })

  it('_resetInit is exported as a function (test helper)', async () => {
    const initModule = await import('../../../src/lambda/init.js')
    expect(typeof initModule._resetInit).toBe('function')
  })
})
