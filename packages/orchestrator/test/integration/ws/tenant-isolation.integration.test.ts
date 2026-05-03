/**
 * test/integration/ws/tenant-isolation.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Tenant isolation tests for the AWS WS fanout path.
 *
 * Critical security invariant:
 *   A WebSocket subscriber on tenant A MUST NOT receive events for tenant B,
 *   even if both are subscribed to the same topic pattern.
 *
 * This test validates the AWS Lambda fanout path (lambda/ws/fanout.ts) rather
 * than the in-process HubModeWebSocketHub (which has its own isolation tests
 * in ws-hub/tenant-isolation.integration.test.ts).
 *
 * The test uses DynamoDB Local + a mock API GW Management API client.
 * DynamoDB Local must be running at DYNAMODB_LOCAL_ENDPOINT or the suite is skipped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'

import type { EventEnvelope } from '@orbital/types'
import { _fanoutEventForTests, _resetClientsForTests } from '../../../src/lambda/ws/fanout.js'

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const DYNAMO_ENDPOINT = process.env['DYNAMODB_LOCAL_ENDPOINT'] ?? 'http://localhost:8000'
const HAS_DDB = process.env['CONNECTIONS_TABLE'] !== undefined || process.env['MOCK_AWS'] !== '1'
const TEST_TABLE = `orbital-connections-isolation-${Date.now()}`

const ddbClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: DYNAMO_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
})

async function createTable(): Promise<void> {
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

interface PostedMessage {
  connectionId: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(tenantId: string, aggregateId: string, payload?: Record<string, unknown>): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: aggregateId,
    aggregate_type: 'task',
    event_type: 'TaskStateChanged',
    payload: { state: 'done', tenant_id: tenantId, ...(payload ?? {}) },
    actor: { type: 'system', component: 'orchestrator' } as EventEnvelope['actor'],
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DDB)('WS Fanout Lambda — tenant isolation (AC5)', () => {
  const TENANT_A = `tenant-a-${uuidv7()}`
  const TENANT_B = `tenant-b-${uuidv7()}`

  const postedMessages: PostedMessage[] = []

  beforeAll(async () => {
    process.env['CONNECTIONS_TABLE'] = TEST_TABLE
    process.env['AWS_REGION'] = 'us-east-1'
    process.env['WS_MGMT_ENDPOINT'] = 'http://mock-mgmt'
    await createTable()
  }, 30_000)

  afterAll(async () => {
    try {
      await ddbClient.send(new DeleteTableCommand({ TableName: TEST_TABLE }))
    } catch { /* ignore */ }
  })

  beforeEach(() => {
    postedMessages.length = 0
    _resetClientsForTests()
    vi.spyOn(ApiGatewayManagementApiClient.prototype, 'send').mockImplementation(
      async (cmd) => {
        const postCmd = cmd as PostToConnectionCommand
        const data = postCmd.input.Data instanceof Buffer
          ? JSON.parse(postCmd.input.Data.toString('utf8')) as Record<string, unknown>
          : {}
        postedMessages.push({
          connectionId: postCmd.input.ConnectionId!,
          data,
        })
      },
    )
  })

  // ------------------------------------------------------------------
  // AC5: subscriber on tenant A does NOT receive tenant B events
  // ------------------------------------------------------------------

  it('subscriber on tenant A does NOT receive tenant B task events', async () => {
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

    // Publish event for TENANT_B — connA must NOT receive it
    const event = makeEvent(TENANT_B, taskId)
    await _fanoutEventForTests(event, TEST_TABLE)

    const connAMessages = postedMessages.filter((m) => m.connectionId === connA)
    expect(connAMessages.length).toBe(0)

    // connB should receive it
    const connBMessages = postedMessages.filter((m) => m.connectionId === connB)
    expect(connBMessages.length).toBe(1)
  })

  it('subscriber on tenant A receives tenant A events (same taskId)', async () => {
    const taskId = uuidv7()
    const connA = `conn-a2-${uuidv7()}`

    await seedConnection({
      connectionId: connA,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${taskId}`],
    })

    const event = makeEvent(TENANT_A, taskId)
    await _fanoutEventForTests(event, TEST_TABLE)

    const connAMessages = postedMessages.filter((m) => m.connectionId === connA)
    expect(connAMessages.length).toBe(1)
    const msg = connAMessages[0]!.data
    expect(msg['ws_type']).toBe('event')
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['aggregate_id']).toBe(taskId)
  })

  it.each([
    { label: 'task', patternFn: (id: string) => `task:${id}`, aggregateType: 'task' as const },
    { label: 'channel', patternFn: (id: string) => `channel:${id}`, aggregateType: 'channel' as const },
    { label: 'project:events', patternFn: (id: string) => `project:${id}:events`, aggregateType: 'task' as const },
  ])(
    'tenant isolation holds for $label subscriptions — cross-tenant event not delivered to tenant A',
    async ({ patternFn, aggregateType }) => {
      const resourceId = uuidv7()
      const connA = `conn-a3-${uuidv7()}`

      await seedConnection({
        connectionId: connA,
        tenantId: TENANT_A,
        installId: uuidv7(),
        subscriptions: [patternFn(resourceId)],
      })

      // Append TENANT_B event — connA must not receive
      const event: EventEnvelope = {
        event_id: uuidv7(),
        aggregate_id: resourceId,
        aggregate_type: aggregateType,
        event_type: 'TaskStateChanged',
        payload: {
          state: 'done',
          tenant_id: TENANT_B, // TENANT_B event
          project_id: resourceId,
          channel_id: resourceId,
          channel_name: resourceId,
        },
        actor: { type: 'system', component: 'orchestrator' } as EventEnvelope['actor'],
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      }

      await _fanoutEventForTests(event, TEST_TABLE)

      const connAMessages = postedMessages.filter((m) => m.connectionId === connA)
      expect(connAMessages.length).toBe(0)
    },
  )

  it('cross-tenant subscribe attempt: connection subscribes to topic, but event for wrong tenant is not delivered', async () => {
    // This tests the fanout-layer isolation — even if a connection is somehow
    // seeded with a subscription that "looks like" it could match a cross-tenant
    // event, the tenant_id check in matchesEvent() prevents delivery.
    const sharedTaskId = uuidv7()
    const connA = `conn-a4-${uuidv7()}`

    // connA is tenant A but somehow has a subscription for the shared task
    await seedConnection({
      connectionId: connA,
      tenantId: TENANT_A,
      installId: uuidv7(),
      subscriptions: [`task:${sharedTaskId}`],
    })

    // Publish event for TENANT_B with the same taskId
    const event = makeEvent(TENANT_B, sharedTaskId)
    await _fanoutEventForTests(event, TEST_TABLE)

    // connA is tenant A — must not receive tenant B's event
    const connAMessages = postedMessages.filter((m) => m.connectionId === connA)
    expect(connAMessages.length).toBe(0)
  })
})
