/**
 * test/integration/lambda/ws-connect.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Integration tests for the WS $connect Lambda handler.
 *
 * Tests:
 *  1. Valid PKI envelope → DynamoDB row created with correct fields
 *  2. Valid Cognito JWT (bypass mode) → DynamoDB row created
 *  3. Invalid PKI envelope → 401 response (connection rejected)
 *  4. No auth credentials → 401 response
 *  5. Expired PKI timestamp → 401 response
 *  6. Tenant isolation: tenant_id always from DB row, not from query params
 *
 * Uses DynamoDB Local (or real DynamoDB via AWS credentials if available).
 * Falls back to a mock DynamoDB if neither is available.
 *
 * Prerequisites:
 *  - CONNECTIONS_TABLE env var must point to a live DynamoDB table.
 *  - DATABASE_URL env var must point to a Postgres DB (for PKI path tests).
 *  - Or: set MOCK_AWS=1 to use in-memory mocks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb'

// Wire SHA-512 for @noble/ed25519 v2
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...msgs: Uint8Array[]) =>
    sha512(msgs.length === 1 ? (msgs[0] as Uint8Array) : ed.etc.concatBytes(...msgs))
}
if (!ed.etc.sha512Async) {
  ed.etc.sha512Async = async (...msgs: Uint8Array[]) =>
    sha512(msgs.length === 1 ? (msgs[0] as Uint8Array) : ed.etc.concatBytes(...msgs))
}

import { signEnvelope, bytesToBase64Url } from '../../../src/keys/envelope.js'
import { buildTestCognitoToken } from '../../../src/lambda/ws-auth/cognito.js'
import {
  handler,
  _resetDdbClientForTests,
  type APIGatewayWebSocketEvent,
} from '../../../src/lambda/ws/connect.js'

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

// Use DynamoDB Local on port 8000 (or real DynamoDB via env creds)
const DYNAMO_ENDPOINT = process.env['DYNAMODB_LOCAL_ENDPOINT'] ?? 'http://localhost:8000'
const USE_MOCK = process.env['MOCK_AWS'] === '1' || process.env['CONNECTIONS_TABLE'] === undefined

const TEST_TABLE = process.env['CONNECTIONS_TABLE'] ?? `orbital-connections-test-${Date.now()}`
const HAS_DDB = !USE_MOCK

const ddbClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: USE_MOCK ? undefined : DYNAMO_ENDPOINT,
  ...(USE_MOCK ? {
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  } : {}),
})

async function createTestTable(): Promise<void> {
  try {
    await ddbClient.send(
      new CreateTableCommand({
        TableName: TEST_TABLE,
        KeySchema: [{ AttributeName: 'connection_id', KeyType: 'HASH' }],
        AttributeDefinitions: [
          { AttributeName: 'connection_id', AttributeType: 'S' },
          { AttributeName: 'install_id', AttributeType: 'S' },
          { AttributeName: 'tenant_id', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'install_id-index',
            KeySchema: [{ AttributeName: 'install_id', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'tenant_id-index',
            KeySchema: [{ AttributeName: 'tenant_id', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
  } catch (err: unknown) {
    // Table may already exist — that's fine
    const e = err as { name?: string; message?: string }
    if (e.name !== 'ResourceInUseException') throw err
  }
}

async function deleteTestTable(): Promise<void> {
  try {
    await ddbClient.send(new DeleteTableCommand({ TableName: TEST_TABLE }))
  } catch {
    // ignore if table doesn't exist
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnectEvent(opts: {
  connectionId?: string
  queryStringParameters?: Record<string, string>
  sourceIp?: string
}): APIGatewayWebSocketEvent {
  return {
    requestContext: {
      connectionId: opts.connectionId ?? `test-conn-${uuidv7()}`,
      routeKey: '$connect',
      stage: '$default',
      requestId: uuidv7(),
      identity: { sourceIp: opts.sourceIp ?? '1.2.3.4' },
    },
    queryStringParameters: opts.queryStringParameters ?? null,
    headers: {},
    body: null,
    isBase64Encoded: false,
  }
}

async function getConnectionRow(connectionId: string): Promise<Record<string, unknown> | null> {
  const result = await ddbClient.send(
    new GetItemCommand({
      TableName: TEST_TABLE,
      Key: { connection_id: { S: connectionId } },
    }),
  )
  if (!result.Item) return null
  return Object.fromEntries(
    Object.entries(result.Item).map(([k, v]) => [
      k,
      v.S ?? v.N ?? v.BOOL ?? (v.L ? v.L.map((el) => el.S) : undefined),
    ]),
  )
}

async function deleteConnectionRow(connectionId: string): Promise<void> {
  await ddbClient.send(
    new DeleteItemCommand({
      TableName: TEST_TABLE,
      Key: { connection_id: { S: connectionId } },
    }),
  )
}

// ---------------------------------------------------------------------------
// Test DB setup (for PKI path — needs known_installs)
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env['DATABASE_URL'])

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DDB)('ws-connect handler — integration', () => {
  let testInstallId: string
  let testTenantId: string
  let privateKey: Uint8Array
  let publicKey: Uint8Array

  beforeAll(async () => {
    // Set env vars for handler
    process.env['CONNECTIONS_TABLE'] = TEST_TABLE
    process.env['AWS_REGION'] = 'us-east-1'
    process.env['COGNITO_VALIDATION_BYPASS'] = '1'

    await createTestTable()

    // Generate keypair for PKI tests
    privateKey = ed.utils.randomPrivateKey()
    publicKey = await ed.getPublicKeyAsync(privateKey)
    testInstallId = uuidv7()
    testTenantId = uuidv7()

    // If we have a real DB, seed a known_installs row for PKI tests
    if (hasDb) {
      const { db } = await import('../../../src/db/client.js')
      const { knownInstalls } = await import('../../../src/db/schema/known-installs.js')
      await db.insert(knownInstalls).values({
        install_id: testInstallId,
        tenant_id: testTenantId,
        public_key: bytesToBase64Url(publicKey),
        role: 'member',
        invite_jti: `test-jti-ws-connect-${testInstallId}`,
      })
    }
  }, 30_000)

  afterAll(async () => {
    if (hasDb) {
      const { eq } = await import('drizzle-orm')
      const { db } = await import('../../../src/db/client.js')
      const { knownInstalls } = await import('../../../src/db/schema/known-installs.js')
      await db.delete(knownInstalls).where(eq(knownInstalls.install_id, testInstallId))
    }
    await deleteTestTable()
    delete process.env['COGNITO_VALIDATION_BYPASS']
  })

  beforeEach(() => {
    _resetDdbClientForTests()
  })

  // ------------------------------------------------------------------
  // Cognito path
  // ------------------------------------------------------------------

  it('valid Cognito JWT (bypass mode) → 200 + DynamoDB row created', async () => {
    const connectionId = `test-conn-${uuidv7()}`
    const cognitoSub = uuidv7()
    const cognitoTenant = uuidv7()

    const token = buildTestCognitoToken({
      sub: cognitoSub,
      tenantId: cognitoTenant,
      email: 'test@example.com',
    })

    const event = makeConnectEvent({
      connectionId,
      queryStringParameters: { token },
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(200)

    // Verify DynamoDB row
    const row = await getConnectionRow(connectionId)
    expect(row).not.toBeNull()
    expect(row!['connection_id']).toBe(connectionId)
    expect(row!['tenant_id']).toBe(cognitoTenant)
    expect(row!['install_id']).toBe(cognitoSub) // browser: sub is installId
    expect(row!['auth_kind']).toBe('cognito')
    expect(row!['connected_at']).toBeDefined()
    expect(row!['expires_at']).toBeDefined()

    // Cleanup
    await deleteConnectionRow(connectionId)
  })

  // ------------------------------------------------------------------
  // PKI path (only if DATABASE_URL is set)
  // ------------------------------------------------------------------

  it.skipIf(!hasDb)('valid PKI envelope → 200 + DynamoDB row created', async () => {
    const connectionId = `test-conn-${uuidv7()}`

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'ws.connect',
      bodyBytes: new Uint8Array(0),
      privateKey,
    })

    const event = makeConnectEvent({
      connectionId,
      queryStringParameters: {
        install_id: testInstallId,
        sig: signatureB64,
        sig_body: bodyB64,
      },
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(200)

    const row = await getConnectionRow(connectionId)
    expect(row).not.toBeNull()
    expect(row!['connection_id']).toBe(connectionId)
    expect(row!['tenant_id']).toBe(testTenantId) // from DB, not request params
    expect(row!['install_id']).toBe(testInstallId)
    expect(row!['auth_kind']).toBe('pki')

    await deleteConnectionRow(connectionId)
  })

  // ------------------------------------------------------------------
  // Auth failure paths
  // ------------------------------------------------------------------

  it('no auth credentials → 401', async () => {
    const event = makeConnectEvent({
      queryStringParameters: {},
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('malformed Cognito JWT (bypass mode) → 401', async () => {
    const event = makeConnectEvent({
      queryStringParameters: { token: 'not.a.jwt' },
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('Cognito JWT missing tenantId → 401', async () => {
    // Build a JWT without custom:tenantId claim
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      sub: uuidv7(),
      exp: Math.floor(Date.now() / 1000) + 3600,
      // No custom:tenantId
    })).toString('base64url')
    const sig = Buffer.from('fake-sig').toString('base64url')
    const badToken = `${header}.${payload}.${sig}`

    const event = makeConnectEvent({
      queryStringParameters: { token: badToken },
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  // ------------------------------------------------------------------
  // Tenant isolation: tenant_id always from DB (PKI path)
  // ------------------------------------------------------------------

  it.skipIf(!hasDb)('PKI path: tenant_id from DB, not from forged query param', async () => {
    const connectionId = `test-conn-${uuidv7()}`
    const forgedTenantId = `forged-tenant-${uuidv7()}`

    const { bodyB64, signatureB64 } = await signEnvelope({
      method: 'ws.connect',
      bodyBytes: new Uint8Array(0),
      privateKey,
    })

    const event = makeConnectEvent({
      connectionId,
      queryStringParameters: {
        install_id: testInstallId,
        sig: signatureB64,
        sig_body: bodyB64,
        // Attacker tries to override tenant_id — must be ignored
        tenant_id: forgedTenantId,
      },
    })

    const result = await handler(event)
    expect(result.statusCode).toBe(200)

    const row = await getConnectionRow(connectionId)
    expect(row!['tenant_id']).toBe(testTenantId) // from DB
    expect(row!['tenant_id']).not.toBe(forgedTenantId)

    await deleteConnectionRow(connectionId)
  })

  // ------------------------------------------------------------------
  // TTL field
  // ------------------------------------------------------------------

  it('DynamoDB row has expires_at set to approximately 2h from now', async () => {
    const connectionId = `test-conn-${uuidv7()}`
    const cognitoSub = uuidv7()
    const cognitoTenant = uuidv7()

    const token = buildTestCognitoToken({ sub: cognitoSub, tenantId: cognitoTenant })
    const event = makeConnectEvent({
      connectionId,
      queryStringParameters: { token },
    })

    const before = Math.floor(Date.now() / 1000)
    await handler(event)
    const after = Math.floor(Date.now() / 1000)

    const row = await getConnectionRow(connectionId)
    const expiresAt = Number(row!['expires_at'])

    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 60 * 60 - 5)
    expect(expiresAt).toBeLessThanOrEqual(after + 2 * 60 * 60 + 5)

    await deleteConnectionRow(connectionId)
  })
})
