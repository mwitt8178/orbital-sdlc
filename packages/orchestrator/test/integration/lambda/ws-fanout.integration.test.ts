/**
 * test/integration/lambda/ws-fanout.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Integration tests for the WS fanout Lambda.
 *
 * Tests:
 *  1. Publish event for tenant A → fanout sends to matching connections for tenant A
 *  2. Publish event for tenant B → connections for tenant A receive nothing (isolation)
 *  3. Connection with non-matching subscription → skipped
 *  4. GoneException → stale DynamoDB row deleted
 *  5. Multiple connections for same tenant → all matching connections receive message
 *
 * This suite uses DynamoDB Local and a mock API GW Management API client
 * to avoid needing real AWS resources. The `WS_MGMT_ENDPOINT` points to
 * a fake server that records `postToConnection` calls.
 *
 * Skip conditions: requires CONNECTIONS_TABLE env var (real or local DDB).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi'

import type { EventEnvelope } from '@orbital/types'
import {
  handler as fanoutHandler,
  _resetClientsForTests,
  _fanoutEventForTests,
  type SnsEvent,
} from '../../../src/lambda/ws/fanout.js'

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const DYNAMO_ENDPOINT = process.env['DYNAMODB_LOCAL_ENDPOINT'] ?? 'http://localhost:8000'
const HAS_DDB = process.env['CONNECTIONS_TABLE'] !== undefined || process.env['MOCK_AWS'] !== '1'
const TEST_TABLE = process.env['CONNECTIONS_TABLE'] ?? `orbital-connections-fanout-test-${Date.now()}`

const ddbClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: DYNAMO_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
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
    const e = err as { name?: string }
    if (e.name !== 'ResourceInUseException') throw err
  }
}

async function deleteTestTable(): Promise<void> {
  try {
    await ddbClient.send(new DeleteTableCommand({ TableName: TEST_TABLE }))
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedConnection(opts: {
  connectionId: string
  tenantId: string
  installId: string
  subscriptions: string[]
}): Promise<void> {
  const now = Date.now()
  await ddbClient.send(
    new PutItemCommand({
      TableName: TEST_TABLE,
      Item: {
        connection_id: { S: opts.connectionId },
        tenant_id: { S: opts.tenantId },
        install_id: { S: opts.installId },
        auth_kind: { S: 'pki' },
        subscriptions: { L: opts.subscriptions.map((s) => ({ S: s })) },
        connected_at: { N: String(now) },
        expires_at: { N: String(Math.floor(now / 1000) + 7200) },
      },
    }),
  )
}

async function connectionExists(connectionId: string): Promise<boolean> {
  const result = await ddbClient.send(
    new GetItemCommand({
      TableName: TEST_TABLE,
      Key: { connection_id: { S: connectionId } },
    }),
  )
  return result.Item !== undefined
}

function makeEventEnvelope(tenantId: string, opts: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskStateChanged',
    payload: { state: 'done', tenant_id: tenantId },
    actor: { type: 'system', component: 'orchestrator' } as EventEnvelope['actor'],
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...opts,
  }
}

function makeSnsEvent(event: EventEnvelope): SnsEvent {
  return {
    Records: [
      {
        Sns: {
          MessageId: uuidv7(),
          Message: JSON.stringify(event),
          MessageAttributes: {
            tenant_id: { Type: 'String', Value: (event.payload as Record<string, unknown>)['tenant_id'] as string },
          },
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Mock API GW Management API
// ---------------------------------------------------------------------------

interface PostedMessage {
  connectionId: string
  data: string
}

class MockApiGatewayMgmt {
  readonly posted: PostedMessage[] = []
  readonly goneConnections = new Set<string>()

  async send(cmd: PostToConnectionCommand): Promise<void> {
    const connectionId = cmd.input.ConnectionId!
    if (this.goneConnections.has(connectionId)) {
      throw new GoneException({
        message: 'Connection no longer exists',
        $metadata: {},
      })
    }
    const data = cmd.input.Data instanceof Buffer
      ? cmd.input.Data.toString('utf8')
      : String(cmd.input.Data ?? '')
    this.posted.push({ connectionId, data })
  }

  markGone(connectionId: string): void {
    this.goneConnections.add(connectionId)
  }

  reset(): void {
    this.posted.length = 0
    this.goneConnections.clear()
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DDB)('ws-fanout handler — integration', () => {
  const TENANT_A = `tenant-a-${uuidv7()}`
  const TENANT_B = `tenant-b-${uuidv7()}`

  let mockMgmt: MockApiGatewayMgmt

  beforeAll(async () => {
    process.env['CONNECTIONS_TABLE'] = TEST_TABLE
    process.env['AWS_REGION'] = 'us-east-1'
    process.env['WS_MGMT_ENDPOINT'] = 'http://localhost:9999' // won't be called (mock)

    await createTestTable()

    // Inject the mock mgmt client into the fanout module
    mockMgmt = new MockApiGatewayMgmt()
  }, 30_000)

  afterAll(async () => {
    await deleteTestTable()
  })

  beforeEach(() => {
    mockMgmt.reset()
    _resetClientsForTests()
    // Patch the ApiGatewayManagementApiClient constructor
    vi.spyOn(ApiGatewayManagementApiClient.prototype, 'send').mockImplementation(
      async (cmd) => mockMgmt.send(cmd as PostToConnectionCommand),
    )
  })

  // ------------------------------------------------------------------
  // Test 1: event matches connection subscription → message delivered
  // ------------------------------------------------------------------

  it('event matches subscription → postToConnection called', async () => {
    const taskId = uuidv7()
    const connectionId = `conn-a-${uuidv7()}`

    await seedConnection({
      connectionId,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    const event = makeEventEnvelope(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskStateChanged',
    })

    await _fanoutEventForTests(event, TEST_TABLE)

    expect(mockMgmt.posted.length).toBe(1)
    expect(mockMgmt.posted[0]!.connectionId).toBe(connectionId)

    const msg = JSON.parse(mockMgmt.posted[0]!.data) as Record<string, unknown>
    expect(msg['ws_type']).toBe('event')
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['aggregate_id']).toBe(taskId)
  })

  // ------------------------------------------------------------------
  // Test 2: event for tenant B → tenant A connection not notified
  // ------------------------------------------------------------------

  it('event for tenant B → tenant A connection receives nothing (tenant isolation)', async () => {
    const taskId = uuidv7()
    const connA = `conn-a-${uuidv7()}`
    const connB = `conn-b-${uuidv7()}`

    await seedConnection({
      connectionId: connA,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    await seedConnection({
      connectionId: connB,
      tenantId: TENANT_B,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    // Publish event for TENANT_B
    const event = makeEventEnvelope(TENANT_B, {
      aggregate_id: taskId,
      aggregate_type: 'task',
    })

    await _fanoutEventForTests(event, TEST_TABLE)

    // Only tenant B connection should receive the message
    const postedConnIds = mockMgmt.posted.map((p) => p.connectionId)
    expect(postedConnIds).toContain(connB)
    expect(postedConnIds).not.toContain(connA)
  })

  // ------------------------------------------------------------------
  // Test 3: connection with non-matching subscription → skipped
  // ------------------------------------------------------------------

  it('connection with non-matching subscription → not notified', async () => {
    const taskId = uuidv7()
    const otherTaskId = uuidv7() // different task
    const connectionId = `conn-skip-${uuidv7()}`

    await seedConnection({
      connectionId,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${otherTaskId}`], // subscribed to different task
    })

    const event = makeEventEnvelope(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
    })

    await _fanoutEventForTests(event, TEST_TABLE)

    const postedConnIds = mockMgmt.posted.map((p) => p.connectionId)
    expect(postedConnIds).not.toContain(connectionId)
  })

  // ------------------------------------------------------------------
  // Test 4: GoneException → stale row deleted from DynamoDB
  // ------------------------------------------------------------------

  it('GoneException on postToConnection → stale connection row deleted', async () => {
    const taskId = uuidv7()
    const staleConnectionId = `conn-gone-${uuidv7()}`

    await seedConnection({
      connectionId: staleConnectionId,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    // Mark this connection as "gone" in the mock
    mockMgmt.markGone(staleConnectionId)

    const event = makeEventEnvelope(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
    })

    await _fanoutEventForTests(event, TEST_TABLE)

    // Row should be deleted
    const exists = await connectionExists(staleConnectionId)
    expect(exists).toBe(false)
  })

  // ------------------------------------------------------------------
  // Test 5: multiple connections for same tenant → all matching receive message
  // ------------------------------------------------------------------

  it('multiple matching connections for tenant → all receive message', async () => {
    const taskId = uuidv7()
    const connIds = [uuidv7(), uuidv7(), uuidv7()].map((id) => `conn-multi-${id}`)

    for (const connectionId of connIds) {
      await seedConnection({
        connectionId,
        tenantId: TENANT_A,
        installId: uuidv7(),
        subscriptions: [`task:${taskId}`],
      })
    }

    const event = makeEventEnvelope(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
    })

    await _fanoutEventForTests(event, TEST_TABLE)

    const postedConnIds = mockMgmt.posted.map((p) => p.connectionId)
    for (const connId of connIds) {
      expect(postedConnIds).toContain(connId)
    }
    expect(mockMgmt.posted.length).toBeGreaterThanOrEqual(connIds.length)
  })

  // ------------------------------------------------------------------
  // Test 6: SNS event shape — handler processes Records array
  // ------------------------------------------------------------------

  it('SNS event with valid record → fanout triggered', async () => {
    const taskId = uuidv7()
    const connectionId = `conn-sns-${uuidv7()}`

    await seedConnection({
      connectionId,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    const event = makeEventEnvelope(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
    })

    const snsEvent = makeSnsEvent(event)
    await fanoutHandler(snsEvent)

    const postedConnIds = mockMgmt.posted.map((p) => p.connectionId)
    expect(postedConnIds).toContain(connectionId)
  })

  // ------------------------------------------------------------------
  // Test 7: event with no tenant_id → no delivery (paranoid default)
  // ------------------------------------------------------------------

  it('event with no tenant_id in payload → no delivery', async () => {
    const connectionId = `conn-notenant-${uuidv7()}`

    await seedConnection({
      connectionId,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: ['task:*'],
    })

    const event: EventEnvelope = {
      event_id: uuidv7(),
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'TaskStateChanged',
      payload: { state: 'done' }, // no tenant_id!
      actor: { type: 'system', component: 'orchestrator' } as EventEnvelope['actor'],
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }

    await _fanoutEventForTests(event, TEST_TABLE)

    expect(mockMgmt.posted.length).toBe(0)
  })
})
