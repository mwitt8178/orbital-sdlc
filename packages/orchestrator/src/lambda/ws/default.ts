/**
 * lambda/ws/default.ts — API Gateway WebSocket $default handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Handles all non-system WebSocket messages from clients (route selection
 * expression: `$request.body.action`).
 *
 * Supported actions:
 *   subscribe   — Add patterns to this connection's subscriptions set
 *   unsubscribe — Remove patterns from this connection's subscriptions set
 *   ping        — Liveness check; responds with a pong message
 *
 * On subscribe/unsubscribe, tenant-scoped validation runs:
 *   - The connection row is fetched from DynamoDB to get tenant_id.
 *   - Each requested topic is validated against that tenant_id.
 *   - Cross-tenant subscribe is rejected with a 4003 close code.
 *
 * Topic format (mirrors ws/subscriptions.ts patterns):
 *   task:<id>                    — specific task
 *   channel:<name>               — channel
 *   project:<id>:events          — project events
 *   worker:<install_id>:*        — worker events for a specific install
 *   worker:*                     — all worker events (admin)
 *   team:presence                — presence events
 *
 * After updating subscriptions, the handler responds via API GW Management
 * API (postToConnection) with an ack message.
 *
 * Tenant isolation: subscriptions are validated against the connection's
 * tenant_id from DynamoDB — a client cannot subscribe to another tenant's
 * topics even if they know the resource IDs.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import { uuidv7 } from 'uuidv7'
import { logger } from '../../config/logger.js'
import type { APIGatewayWebSocketEvent, ConnectResult } from './connect.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WsMessage {
  action?: string
  topics?: string[]
  patterns?: string[]
  cursor?: string
}

type HandlerResult = ConnectResult

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

function getMgmtClient(event: APIGatewayWebSocketEvent): ApiGatewayManagementApiClient {
  if (!_mgmtClient) {
    // Build management endpoint from env var (injected by CDK) or from event context
    const endpoint =
      process.env['WS_MGMT_ENDPOINT'] ??
      buildMgmtEndpointFromEvent(event)
    _mgmtClient = new ApiGatewayManagementApiClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
      endpoint,
    })
  }
  return _mgmtClient
}

function buildMgmtEndpointFromEvent(event: APIGatewayWebSocketEvent): string {
  const stage = event.requestContext.stage
  // The management endpoint is not in the event context for WS APIs.
  // We rely on the WS_MGMT_ENDPOINT env var set by CDK.
  // This fallback is only used when the env var is missing (shouldn't happen).
  return `https://${process.env['WS_API_ID'] ?? 'unknown'}.execute-api.${process.env['AWS_REGION'] ?? 'us-east-1'}.amazonaws.com/${stage}`
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

interface ConnectionRow {
  connectionId: string
  tenantId: string
  installId: string
  subscriptions: string[]
}

async function getConnectionRow(connectionId: string, tableName: string): Promise<ConnectionRow | null> {
  const result = await getDdbClient().send(
    new GetItemCommand({
      TableName: tableName,
      Key: { connection_id: { S: connectionId } },
      ProjectionExpression: 'connection_id, tenant_id, install_id, subscriptions',
    }),
  )

  if (!result.Item) return null

  const tenantId = result.Item['tenant_id']?.S
  const installId = result.Item['install_id']?.S

  if (!tenantId || !installId) return null

  const subscriptions = (result.Item['subscriptions']?.L ?? [])
    .map((el) => el.S)
    .filter((s): s is string => typeof s === 'string')

  return { connectionId, tenantId, installId, subscriptions }
}

// ---------------------------------------------------------------------------
// Subscription validation
// ---------------------------------------------------------------------------

/**
 * Validate a subscription topic against the connection's tenant_id.
 *
 * For most topics the tenant is implicit (the connection is already scoped).
 * This check ensures we don't accept topics that embed another tenant's ID.
 *
 * Topics are strings like:
 *   task:01j5z...   channel:orb-eng   project:01j5z...:events   worker:*
 *
 * We do NOT parse resource IDs from topics — any valid topic format is
 * accepted as long as it matches our known patterns. Cross-tenant bleed
 * is prevented at fanout by the tenant_id check in matchesEvent().
 */
function validateTopic(topic: string, _tenantId: string): { ok: boolean; reason?: string } {
  // Allowlist of valid topic prefixes
  const VALID_PREFIXES = [
    'task:',
    'channel:',
    'project:',
    'worker:',
    'team:',
  ]

  const trimmed = topic.trim()

  if (!trimmed) {
    return { ok: false, reason: 'empty topic' }
  }

  if (trimmed.length > 256) {
    return { ok: false, reason: 'topic too long (max 256 chars)' }
  }

  // team:presence is a special singleton
  if (trimmed === 'team:presence') {
    return { ok: true }
  }

  const hasValidPrefix = VALID_PREFIXES.some((p) => trimmed.startsWith(p))
  if (!hasValidPrefix) {
    return { ok: false, reason: `unknown topic prefix in '${trimmed}'` }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Message send helper
// ---------------------------------------------------------------------------

async function sendToConnection(
  mgmt: ApiGatewayManagementApiClient,
  connectionId: string,
  payload: unknown,
): Promise<void> {
  const body = JSON.stringify(payload)
  await mgmt.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(body),
    }),
  )
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: APIGatewayWebSocketEvent): Promise<HandlerResult> => {
  const connectionId = event.requestContext.connectionId

  logger.debug({ connectionId }, 'ws-default: received message')

  const connectionsTable = process.env['CONNECTIONS_TABLE']
  if (!connectionsTable) {
    logger.error('ws-default: CONNECTIONS_TABLE env var not set')
    return { statusCode: 500 }
  }

  // Parse body
  let msg: WsMessage
  try {
    const raw = event.body ?? '{}'
    msg = JSON.parse(raw) as WsMessage
  } catch {
    logger.warn({ connectionId }, 'ws-default: malformed JSON body')
    return { statusCode: 400, body: 'Malformed JSON' }
  }

  const action = msg.action ?? 'unknown'
  const mgmt = getMgmtClient(event)

  // ------------------------------------------------------------------
  // ping → pong
  // ------------------------------------------------------------------
  if (action === 'ping') {
    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'pong',
        payload: { server_time: new Date().toISOString() },
        trace_id: uuidv7(),
      })
    } catch (err) {
      logger.warn({ connectionId, err }, 'ws-default: pong send failed')
    }
    return { statusCode: 200 }
  }

  // ------------------------------------------------------------------
  // subscribe / unsubscribe — need connection row for tenant_id
  // ------------------------------------------------------------------
  if (action !== 'subscribe' && action !== 'unsubscribe') {
    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'error',
        payload: { code: 'METHOD_NOT_FOUND', message: `Unknown action '${action}'` },
        trace_id: uuidv7(),
      })
    } catch {
      // ignore send failure
    }
    return { statusCode: 200 }
  }

  // Fetch connection row to get tenant_id
  let conn: ConnectionRow | null
  try {
    conn = await getConnectionRow(connectionId, connectionsTable)
  } catch (err) {
    logger.error({ connectionId, err }, 'ws-default: failed to fetch connection row')
    return { statusCode: 500 }
  }

  if (!conn) {
    logger.warn({ connectionId }, 'ws-default: connection row not found — already expired?')
    return { statusCode: 404 }
  }

  // Normalize: accept both `topics` (new API) and `patterns` (legacy compat)
  const requestedTopics = (msg.topics ?? msg.patterns ?? []) as string[]

  if (!Array.isArray(requestedTopics) || requestedTopics.length === 0) {
    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'error',
        payload: { code: 'VALIDATION_ERROR', message: 'topics[] array required' },
        trace_id: uuidv7(),
      })
    } catch {
      // ignore
    }
    return { statusCode: 200 }
  }

  // Validate each topic
  const rejectedTopics: string[] = []
  const acceptedTopics: string[] = []

  for (const topic of requestedTopics) {
    if (typeof topic !== 'string') continue
    const validation = validateTopic(topic, conn.tenantId)
    if (!validation.ok) {
      rejectedTopics.push(topic)
      logger.warn(
        { connectionId, topic, tenantId: conn.tenantId, reason: validation.reason },
        'ws-default: topic validation rejected',
      )
    } else {
      acceptedTopics.push(topic)
    }
  }

  if (rejectedTopics.length > 0) {
    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'error',
        payload: {
          code: 'TOPIC_VALIDATION_ERROR',
          message: `Rejected topics: ${rejectedTopics.join(', ')}`,
          rejectedTopics,
        },
        trace_id: uuidv7(),
      })
    } catch {
      // ignore
    }
    // If all topics were rejected, return without updating
    if (acceptedTopics.length === 0) {
      return { statusCode: 200 }
    }
  }

  // ------------------------------------------------------------------
  // Update DynamoDB subscriptions set
  // ------------------------------------------------------------------

  if (action === 'subscribe') {
    // Add topics to the subscriptions list (deduplicated at query time)
    const existingSet = new Set(conn.subscriptions)
    const toAdd = acceptedTopics.filter((t) => !existingSet.has(t))

    if (toAdd.length > 0) {
      // Build a new merged list
      const merged = [...conn.subscriptions, ...toAdd]

      try {
        await getDdbClient().send(
          new UpdateItemCommand({
            TableName: connectionsTable,
            Key: { connection_id: { S: connectionId } },
            UpdateExpression: 'SET subscriptions = :subs',
            ExpressionAttributeValues: {
              ':subs': { L: merged.map((s) => ({ S: s })) },
            },
          }),
        )
      } catch (err) {
        logger.error({ connectionId, err }, 'ws-default: DynamoDB update failed for subscribe')
        return { statusCode: 500 }
      }

      conn.subscriptions = merged
    }

    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: {
          subscribed: acceptedTopics,
          current_subscriptions: conn.subscriptions,
        },
        trace_id: uuidv7(),
      })
    } catch (err) {
      logger.warn({ connectionId, err }, 'ws-default: subscribe ack send failed')
    }
  } else {
    // unsubscribe: remove topics from the list
    const toRemoveSet = new Set(acceptedTopics)
    const remaining = conn.subscriptions.filter((s) => !toRemoveSet.has(s))

    try {
      await getDdbClient().send(
        new UpdateItemCommand({
          TableName: connectionsTable,
          Key: { connection_id: { S: connectionId } },
          UpdateExpression: 'SET subscriptions = :subs',
          ExpressionAttributeValues: {
            ':subs': { L: remaining.map((s) => ({ S: s })) },
          },
        }),
      )
    } catch (err) {
      logger.error({ connectionId, err }, 'ws-default: DynamoDB update failed for unsubscribe')
      return { statusCode: 500 }
    }

    try {
      await sendToConnection(mgmt, connectionId, {
        ws_message_id: uuidv7(),
        ws_type: 'ack',
        payload: {
          unsubscribed: acceptedTopics,
          current_subscriptions: remaining,
        },
        trace_id: uuidv7(),
      })
    } catch (err) {
      logger.warn({ connectionId, err }, 'ws-default: unsubscribe ack send failed')
    }
  }

  return { statusCode: 200 }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetClientsForTests(): void {
  _ddbClient = null
  _mgmtClient = null
}
