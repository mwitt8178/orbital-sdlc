/**
 * lambda/ws/disconnect.ts — API Gateway WebSocket $disconnect handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Invoked by API Gateway when a WebSocket client disconnects (gracefully or
 * due to network timeout / idle timeout).
 *
 * Removes the DynamoDB connection row so:
 *   1. Fanout does not attempt postToConnection on a dead connection.
 *   2. The connections table stays clean (TTL also covers ungraceful drops).
 *
 * This handler is intentionally simple — it never fails the disconnect even
 * if the DB delete fails (the TTL will clean it up within 2h).
 *
 * API Gateway guarantees that $disconnect is always called, even on network
 * interruptions (after a 10-minute idle timeout on the gateway side).
 */

import {
  DynamoDBClient,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb'
import { logger } from '../../config/logger.js'
import type { APIGatewayWebSocketEvent, ConnectResult } from './connect.js'

// ---------------------------------------------------------------------------
// Module-scoped DynamoDB client
// ---------------------------------------------------------------------------

let _ddbClient: DynamoDBClient | null = null

function getDdbClient(): DynamoDBClient {
  if (!_ddbClient) {
    _ddbClient = new DynamoDBClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
    })
  }
  return _ddbClient
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: APIGatewayWebSocketEvent): Promise<ConnectResult> => {
  const connectionId = event.requestContext.connectionId

  logger.debug({ connectionId }, 'ws-disconnect: received $disconnect')

  const connectionsTable = process.env['CONNECTIONS_TABLE']
  if (!connectionsTable) {
    // Log the misconfiguration but still return 200 — disconnect must succeed.
    logger.error('ws-disconnect: CONNECTIONS_TABLE env var not set')
    return { statusCode: 200 }
  }

  try {
    await getDdbClient().send(
      new DeleteItemCommand({
        TableName: connectionsTable,
        Key: {
          connection_id: { S: connectionId },
        },
      }),
    )
    logger.info({ connectionId }, 'ws-disconnect: connection row deleted')
  } catch (err) {
    // Log but do not fail — API GW requires a 2xx from $disconnect.
    // The TTL on expires_at will clean up the stale row within 2h.
    logger.warn({ connectionId, err }, 'ws-disconnect: DynamoDB deleteItem failed (TTL will clean up)')
  }

  return { statusCode: 200 }
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

export function _resetDdbClientForTests(): void {
  _ddbClient = null
}
