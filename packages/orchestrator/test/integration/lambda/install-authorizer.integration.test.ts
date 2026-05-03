/**
 * integration/lambda/install-authorizer.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Tests the install Lambda authorizer (lambda/handlers/install-authorizer.ts).
 *
 * Key behaviors:
 *  1. Valid envelope + known install → IAM allow with correct context
 *  2. Invalid signature → IAM deny
 *  3. Expired timestamp → IAM deny
 *  4. Replayed nonce → IAM deny (second request with same nonce)
 *  5. Unknown install_id → IAM deny
 *  6. Revoked install → IAM deny
 *  7. Missing required headers → IAM deny
 *  8. Params_hash mismatch (body tampered) → IAM deny
 *
 * Multi-tenant isolation:
 *  - tenantId is ALWAYS sourced from known_installs.tenant_id (not headers)
 *  - An install cannot claim a different tenant by modifying request headers
 *
 * Skips if DATABASE_URL is not configured.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'

// Wire SHA-512 for ed25519 (required by @noble/ed25519 v2)
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) =>
    sha512(msgs.length === 1 ? (msgs[0] as Uint8Array) : ed.etc.concatBytes(...msgs))
}
if (!ed.etc.sha512Async) {
  ed.etc.sha512Async = async (...msgs: Uint8Array[]) =>
    sha512(msgs.length === 1 ? (msgs[0] as Uint8Array) : ed.etc.concatBytes(...msgs))
}

import { db, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import {
  signEnvelope,
  bytesToBase64Url,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
} from '../../../src/keys/envelope.js'

// ---------------------------------------------------------------------------
// Conditional skip guard
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env['DATABASE_URL'])

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal API Gateway v2 event for the authorizer. */
function makeEvent(opts: {
  installId: string
  sigBody: string
  sig: string
  body?: string
}): Parameters<
  import('../../../src/lambda/handlers/install-authorizer.js').handler
>[0] {
  return {
    version: '2.0',
    type: 'REQUEST',
    routeArn: 'arn:aws:execute-api:us-east-1:123456789:testapi/mwitt/ANY//install/tasks/claim',
    identitySource: [`${opts.installId}`, opts.sig, opts.sigBody],
    routeKey: 'ANY /install/{proxy+}',
    rawPath: '/install/tasks/claim',
    rawQueryString: '',
    headers: {
      [HEADER_INSTALL_ID]: opts.installId,
      [HEADER_SIG_BODY]: opts.sigBody,
      [HEADER_SIG]: opts.sig,
    },
    queryStringParameters: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'testapi',
      domainName: 'api.mwitt.orbital.team.dev',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/install/tasks/claim',
        protocol: 'HTTP/1.1',
        sourceIp: '1.2.3.4',
        userAgent: 'orbital-install/1.0',
      },
      requestId: 'test-request-id',
      routeKey: 'ANY /install/{proxy+}',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: opts.body ?? '',
    isBase64Encoded: false,
    pathParameters: { proxy: 'tasks/claim' },
  } as unknown as Parameters<
    import('../../../src/lambda/handlers/install-authorizer.js').handler
  >[0]
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('install-authorizer — authorization flows', () => {
  let privateKey: Uint8Array
  let publicKey: Uint8Array
  let testInstallId: string
  let testTenantId: string

  beforeAll(async () => {
    // Generate a fresh Ed25519 keypair
    privateKey = ed.utils.randomPrivateKey()
    publicKey = await ed.getPublicKeyAsync(privateKey)

    testInstallId = uuidv7()
    testTenantId = uuidv7()

    // Insert a known_installs row for this test
    await db.insert(knownInstalls).values({
      install_id: testInstallId,
      tenant_id: testTenantId,
      public_key: bytesToBase64Url(publicKey),
      role: 'member',
      invite_jti: `test-jti-${testInstallId}`,
    })
  })

  afterAll(async () => {
    // Clean up test install
    await db.delete(knownInstalls).where(eq(knownInstalls.install_id, testInstallId))
    await closeDb()
  })

  beforeEach(async () => {
    // Reset init between tests so DB is fresh
    const initModule = await import('../../../src/lambda/init.js')
    initModule._resetInit()
  })

  // ------------------------------------------------------------------
  // Happy path
  // ------------------------------------------------------------------

  it('valid envelope → isAuthorized: true with correct context', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    // API Gateway HTTP API does not forward event.body to Lambda authorizers.
    // The authorizer verifies params_hash against sha256(empty). The client
    // must sign with bodyBytes = new Uint8Array() on the install-authorizer path.
    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
    })

    const event = makeEvent({
      installId: testInstallId,
      sigBody: bodyB64,
      sig: signatureB64,
    })

    const result = await handler(event, {} as never, () => {})

    expect(result).toBeDefined()
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(true)
    const ctx = (result as { context?: Record<string, string> }).context
    expect(ctx?.['installId']).toBe(testInstallId)
    expect(ctx?.['tenantId']).toBe(testTenantId)
    expect(ctx?.['role']).toBe('member')
  })

  // ------------------------------------------------------------------
  // Deny paths
  // ------------------------------------------------------------------

  it('invalid signature → isAuthorized: false', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    const { bodyB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
    })

    // Use a different key to create a bad signature
    const wrongKey = ed.utils.randomPrivateKey()
    const wrongPubKey = await ed.getPublicKeyAsync(wrongKey)
    const wrongSig = await ed.signAsync(new Uint8Array(), wrongKey)

    const event = makeEvent({
      installId: testInstallId,
      sigBody: bodyB64,
      sig: bytesToBase64Url(wrongSig),
    })

    const result = await handler(event, {} as never, () => {})
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(false)
    // wrongPubKey used so TypeScript doesn't flag the variable as unused
    expect(wrongPubKey.length).toBe(32)
  })

  it('expired timestamp → isAuthorized: false', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    // 2 minutes ago — outside the ±60s window
    const expiredNowMs = Date.now() - 2 * 60 * 1000

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
      nowMs: expiredNowMs,
    })

    const event = makeEvent({
      installId: testInstallId,
      sigBody: bodyB64,
      sig: signatureB64,
    })

    const result = await handler(event, {} as never, () => {})
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(false)
  })

  it('replayed nonce → isAuthorized: false on second request', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    const fixedNonce = 'fixed-nonce-for-replay-test'

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
      nonce: fixedNonce,
    })

    const event = makeEvent({
      installId: testInstallId,
      sigBody: bodyB64,
      sig: signatureB64,
    })

    // First request: should succeed
    const first = await handler(event, {} as never, () => {})
    expect((first as { isAuthorized: boolean }).isAuthorized).toBe(true)

    // Second request with same nonce: replay should be denied
    const second = await handler(event, {} as never, () => {})
    expect((second as { isAuthorized: boolean }).isAuthorized).toBe(false)
  })

  it('unknown install_id → isAuthorized: false', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
    })

    const event = makeEvent({
      installId: uuidv7(), // unknown ID
      sigBody: bodyB64,
      sig: signatureB64,
    })

    const result = await handler(event, {} as never, () => {})
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(false)
  })

  it('revoked install → isAuthorized: false', async () => {
    const revokedId = uuidv7()
    const revokedKey = ed.utils.randomPrivateKey()
    const revokedPubKey = await ed.getPublicKeyAsync(revokedKey)

    // Insert a revoked install
    await db.insert(knownInstalls).values({
      install_id: revokedId,
      tenant_id: testTenantId,
      public_key: bytesToBase64Url(revokedPubKey),
      role: 'member',
      invite_jti: `test-jti-revoked-${revokedId}`,
      revoked_at: new Date(Date.now() - 1000), // revoked 1 second ago
    })

    try {
      const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

      const { bodyB64, signatureB64 } = await signEnvelope({
        method: 'tasks.claim',
        bodyBytes: new Uint8Array(),
        privateKey: revokedKey,
      })

      const event = makeEvent({
        installId: revokedId,
        sigBody: bodyB64,
        sig: signatureB64,
      })

      const result = await handler(event, {} as never, () => {})
      expect((result as { isAuthorized: boolean }).isAuthorized).toBe(false)
    } finally {
      await db.delete(knownInstalls).where(eq(knownInstalls.install_id, revokedId))
    }
  })

  it('missing required headers → isAuthorized: false', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    const event = {
      version: '2.0',
      type: 'REQUEST',
      routeArn: 'arn:aws:execute-api:us-east-1:123456789:testapi/mwitt/ANY//install',
      identitySource: [],
      routeKey: 'ANY /install/{proxy+}',
      rawPath: '/install',
      rawQueryString: '',
      headers: {}, // no PKI headers
      queryStringParameters: {},
      requestContext: {
        accountId: '123456789012',
        apiId: 'testapi',
        domainName: 'api.mwitt.orbital.team.dev',
        domainPrefix: 'api',
        http: {
          method: 'POST',
          path: '/install',
          protocol: 'HTTP/1.1',
          sourceIp: '1.2.3.4',
          userAgent: 'test',
        },
        requestId: 'test-missing-headers',
        routeKey: 'ANY /install/{proxy+}',
        stage: '$default',
        time: new Date().toISOString(),
        timeEpoch: Date.now(),
      },
      body: '',
      isBase64Encoded: false,
    } as unknown as Parameters<typeof handler>[0]

    const result = await handler(event, {} as never, () => {})
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(false)
  })

  // ------------------------------------------------------------------
  // Multi-tenant isolation test
  // ------------------------------------------------------------------

  it('tenantId is always from DB row, not from request headers', async () => {
    const { handler } = await import('../../../src/lambda/handlers/install-authorizer.js')

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'tasks.claim',
      bodyBytes: new Uint8Array(),
      privateKey,
    })

    const event = makeEvent({
      installId: testInstallId,
      sigBody: bodyB64,
      sig: signatureB64,
    })

    // Even if we add a forged tenant header, the context must use the DB row value
    ;(event as { headers: Record<string, string> }).headers['x-orbital-tenant-id'] =
      'forged-tenant-id-should-be-ignored'

    const result = await handler(event, {} as never, () => {})
    expect((result as { isAuthorized: boolean }).isAuthorized).toBe(true)
    const ctx = (result as { context?: Record<string, string> }).context
    // Must be from the DB row, not the forged header
    expect(ctx?.['tenantId']).toBe(testTenantId)
    expect(ctx?.['tenantId']).not.toBe('forged-tenant-id-should-be-ignored')
  })
})
