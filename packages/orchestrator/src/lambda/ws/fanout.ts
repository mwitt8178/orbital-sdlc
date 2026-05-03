/**
 * lambda/ws/fanout.ts — WebSocket fanout Lambda.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Triggered by SNS events (Round 8-05 will create the SNS topic).
 * For each published event, this Lambda:
 *   1. Extracts the tenant_id and subscription-matching metadata.
 *   2. Queries DynamoDB GSI `tenant_id-index` for all connections in that tenant.
 *   3. Filters connections by subscriptions using matchesEvent() from ws/subscriptions.ts.
 *   4. For each matching connection: calls API GW Management API postToConnection.
 *   5. On GoneException (connection disconnected): deletes the stale DynamoDB row.
 *
 * SNS event shape:
 *   The SNS message body is a JSON-serialized EventEnvelope (from @orbital/types).
 *   Message attributes carry tenant_id for SNS subscription filter policies.
 *
 * Hub-side trigger:
 *   The events/store.ts can call pushEventToWs() from aws-fanout.ts after append.
 *   This is wired by 8-05 via SNS. The fanout Lambda is the canonical consumer.
 *
 * Tenant isolation:
 *   - Connections are queried by tenant_id GSI (structural isolation).
 *   - matchesEvent() performs a second tenant check before any message is sent.
 *   - A connection on tenant A can NEVER receive a message for tenant B.
 *
 * Error handling:
 *   - GoneException: normal; connection closed. Row deleted.
 *   - ThrottlingException / provisioned-throughput exceeded: retried by Lambda runtime.
 *   - Partial failures (some connections sent, some not): logged individually.
 *   - DLQ on the Lambda event source (configured in CDK stack) catches hard failures.
 */

import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi'
import { uuidv7 } from 'uuidv7'
import { logger } from '../../config/logger.js'
import { matchesEvent } from '../../ws/subscriptions.js'
import type { EventEnvelope } from '@orbital/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SNS message record shape (from Lambda trigger). */
interface SnsRecord {
  Sns: {
    MessageId: string
    Message: string
    MessageAttributes?: Record<string, { Type: string; Value: string }>
  }
}

export interface SnsEvent {
  Records: SnsRecord[]
}

/** Shape of a connection row from DynamoDB. */
interface ConnectionRow {
  connectionId: string
  tenantId: string
  installId: string
  subscriptions: string[]
}

// ---------------------------------------------------------------------------
// Module-scoped clients
// ---------------------------------------------------------------------------

let _ddbClient: DynamoDBClient | null = null
let _mgmtClient: ApiGatewayManagementApiClient | null = null

function getDdbClient(): DynamoDBClient {
  if (!_ddbClient) {
    _ddbClient = new DynamoDBClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
    })
  }
  return _ddbClient
}

function getMgmtClient(): ApiGatewayManagementApiClient {
  if (!_mgmtClient) {
    const endpoint = process.env['WS_MGMT_ENDPOINT']
    if (!endpoint) {
      throw new Error('fanout: WS_MGMT_ENDPOINT env var not set — cannot call postToConnection')
    }
    _mgmtClient = new ApiGatewayManagementApiClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
      endpoint,
    })
  }
  return _mgmtClient
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

/** Deserialize a DynamoDB AttributeValue map to a ConnectionRow. */
function deserializeConnectionRow(
  item: Record<string, AttributeValue>,
): ConnectionRow | null {
  const connectionId = item['connection_id']?.S
  const tenantId = item['tenant_id']?.S
  const installId = item['install_id']?.S

  if (!connectionId || !tenantId || !installId) return null

  const subscriptions = (item['subscriptions']?.L ?? [])
    .map((el) => el.S)
    .filter((s): s is string => typeof s === 'string')

  return { connectionId, tenantId, installId, subscriptions }
}

/**
 * Query all WS connections for a given tenant via the tenant_id-index GSI.
 * Paginates through all results.
 */
async function queryConnectionsByTenant(
  tenantId: string,
  tableName: string,
): Promise<ConnectionRow[]> {
  const connections: ConnectionRow[] = []
  let lastKey: Record<string, AttributeValue> | undefined

  do {
    const result = await getDdbClient().send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'tenant_id-index',
        KeyConditionExpression: 'tenant_id = :tid',
        ExpressionAttributeValues: {
          ':tid': { S: tenantId },
        },
        ExclusiveStartKey: lastKey,
        // Project only what we need for filtering — avoids fetching large payloads
        ProjectionExpression: 'connection_id, tenant_id, install_id, subscriptions',
      }),
    )

    for (const item of result.Items ?? []) {
      const row = deserializeConnectionRow(item)
      if (row) connections.push(row)
    }

    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return connections
}

/** Delete a stale connection row (called when GoneException is received). */
async function deleteStaleConnection(connectionId: string, tableName: string): Promise<void> {
  try {
    await getDdbClient().send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { connection_id: { S: connectionId } },
      }),
    )
    logger.debug({ connectionId }, 'fanout: deleted stale connection row')
  } catch (err) {
    logger.warn({ connectionId, err }, 'fanout: failed to delete stale connection row')
  }
}

// ---------------------------------------------------------------------------
// Fanout logic
// ---------------------------------------------------------------------------

/**
 * Fan out a single event to all matching WebSocket connections for that tenant.
 */
async function fanoutEvent(
  event: EventEnvelope,
  tableName: string,
): Promise<void> {
  // Extract tenant_id from event payload (canonical location per subscriptions.ts)
  const payload = event.payload as Record<string, unknown>
  const tenantId =
    (typeof payload['tenant_id'] === 'string' ? payload['tenant_id'] : null) ??
    ((event as unknown as Record<string, unknown>)['_hub_tenant_id'] as string | undefined)

  if (!tenantId) {
    logger.warn(
      { eventId: event.event_id, eventType: event.event_type },
      'fanout: event has no tenant_id — skipping (paranoid default)',
    )
    return
  }

  // Query connections for this tenant
  let connections: ConnectionRow[]
  try {
    connections = await queryConnectionsByTenant(tenantId, tableName)
  } catch (err) {
    logger.error({ tenantId, err }, 'fanout: DynamoDB query failed')
    throw err // Let Lambda runtime retry
  }

  if (connections.length === 0) {
    logger.debug({ tenantId, eventId: event.event_id }, 'fanout: no connections for tenant — no-op')
    return
  }

  logger.debug(
    { tenantId, eventId: event.event_id, connectionCount: connections.length },
    'fanout: queried connections',
  )

  const mgmt = getMgmtClient()

  // Build the WS message envelope
  const wsEnvelope = JSON.stringify({
    ws_message_id: uuidv7(),
    ws_type: 'event',
    cursor: event.event_id,
    payload: {
      event_id: event.event_id,
      event_type: event.event_type,
      aggregate_type: event.aggregate_type,
      aggregate_id: event.aggregate_id,
      payload: event.payload,
      actor: event.actor,
      occurred_at: event.occurred_at,
    },
    trace_id: event.trace_id,
  })

  let sent = 0
  let stale = 0
  let skipped = 0

  for (const conn of connections) {
    // Second tenant isolation check (belt-and-suspenders; GSI query already scoped)
    if (conn.tenantId !== tenantId) {
      logger.error(
        { connectionId: conn.connectionId, connTenant: conn.tenantId, eventTenant: tenantId },
        'fanout: TENANT MISMATCH from GSI — skipping (should never happen)',
      )
      skipped++
      continue
    }

    // Pattern match via subscriptions.ts
    const patternSet = new Set(conn.subscriptions)
    if (!matchesEvent(event, tenantId, patternSet)) {
      skipped++
      continue
    }

    // Send message
    try {
      await mgmt.send(
        new PostToConnectionCommand({
          ConnectionId: conn.connectionId,
          Data: Buffer.from(wsEnvelope),
        }),
      )
      sent++
    } catch (err) {
      if (err instanceof GoneException) {
        // Connection is gone — clean up the stale row
        stale++
        await deleteStaleConnection(conn.connectionId, tableName)
      } else {
        // Log non-GoneException errors but continue fanning out to other connections
        logger.warn(
          { connectionId: conn.connectionId, err },
          'fanout: postToConnection failed (non-GoneException)',
        )
      }
    }
  }

  logger.info(
    {
      tenantId,
      eventId: event.event_id,
      eventType: event.event_type,
      sent,
      stale,
      skipped,
      total: connections.length,
    },
    'fanout: event fanned out',
  )
}

// ---------------------------------------------------------------------------
// SNS event handler
// ---------------------------------------------------------------------------

export const handler = async (snsEvent: SnsEvent): Promise<void> => {
  const connectionsTable = process.env['CONNECTIONS_TABLE']
  if (!connectionsTable) {
    throw new Error('fanout: CONNECTIONS_TABLE env var not set')
  }

  for (const record of snsEvent.Records) {
    const messageId = record.Sns.MessageId

    let event: EventEnvelope
    try {
      event = JSON.parse(record.Sns.Message) as EventEnvelope
    } catch (err) {
      logger.error({ messageId, err }, 'fanout: failed to parse SNS message body')
      // Don't rethrow — skip malformed messages to avoid DLQ thrash on bad data
      continue
    }

    logger.debug({ messageId, eventId: event.event_id, eventType: event.event_type }, 'fanout: processing event')

    try {
      await fanoutEvent(event, connectionsTable)
    } catch (err) {
      logger.error({ messageId, eventId: event.event_id, err }, 'fanout: fanoutEvent threw')
      // Rethrow so Lambda retries (and eventually sends to DLQ)
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Hub-side trigger function (called by events/store.ts after append in AWS mode)
// ---------------------------------------------------------------------------

/**
 * pushToWs — called by the events store (or aws-fanout helper) to publish
 * an event directly to the fanout Lambda via DynamoDB + APIGW flow.
 *
 * In Round 8-05, this is triggered by SNS publish. For now, this function
 * exposes a way to call fanoutEvent directly (e.g. from aws-fanout.ts for
 * testing or for a direct-invoke path without SNS).
 */
export async function pushToWs(
  event: EventEnvelope,
  connectionsTable: string,
): Promise<void> {
  await fanoutEvent(event, connectionsTable)
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetClientsForTests(): void {
  _ddbClient = null
  _mgmtClient = null
}

export { fanoutEvent as _fanoutEventForTests }
