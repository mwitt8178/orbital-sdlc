/**
 * lambda/ws/connect.ts — API Gateway WebSocket $connect handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Invoked by API Gateway when a WebSocket client connects.
 * Validates authentication (Cognito JWT for browsers, PKI envelope for installs),
 * then writes a DynamoDB connection row with TTL.
 *
 * Auth flow:
 *   Cognito (browser): query string `?token=<cognito-jwt>`
 *     - Validates JWT signature against Cognito JWKS endpoint
 *     - Extracts sub (userId), email, cognito:groups for tenantId
 *   PKI (install): query string `?install_id=<id>&sig=<b64>&sig_body=<b64>`
 *     - Validates Ed25519 envelope against known_installs.public_key in Aurora
 *
 * DynamoDB row written on success:
 *   PK: connection_id (from requestContext.connectionId)
 *   install_id: derived from auth
 *   tenant_id: derived from auth (always from DB/JWT, never from request headers)
 *   auth_kind: 'cognito' | 'pki'
 *   subscriptions: [] (empty on connect; populated by $default handler)
 *   connected_at: ms since epoch
 *   expires_at: Unix epoch seconds (2h TTL)
 *
 * Returns 200 to accept the connection, 401 to reject it.
 *
 * Tenant isolation: tenant_id is ALWAYS sourced from Aurora (PKI path) or
 * from the verified JWT's custom:tenant_id claim (Cognito path). Request
 * parameters cannot override this.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  type PutItemCommandInput,
} from '@aws-sdk/client-dynamodb'
import { logger } from '../../config/logger.js'
import { verifyWsHandshake } from '../../ws/auth.js'
import { verifyCognitoJwt, type CognitoIdentity } from '../ws-auth/cognito.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface APIGatewayWebSocketEvent {
  requestContext: {
    connectionId: string
    routeKey: string
    stage: string
    requestId?: string
    identity?: {
      sourceIp?: string
    }
  }
  queryStringParameters?: Record<string, string> | null
  multiValueQueryStringParameters?: Record<string, string[]> | null
  headers?: Record<string, string> | null
  body?: string | null
  isBase64Encoded?: boolean
}

export type ConnectResult = {
  statusCode: number
  body?: string
}

// ---------------------------------------------------------------------------
// Module-scoped DynamoDB client (reused across warm invocations)
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
// Auth result type
// ---------------------------------------------------------------------------

interface AuthResult {
  installId: string
  tenantId: string
  userId?: string
  kind: 'cognito' | 'pki'
}

// ---------------------------------------------------------------------------
// Auth validators
// ---------------------------------------------------------------------------

/**
 * Validate a Cognito JWT passed in the `token` query string parameter.
 * Returns an AuthResult on success, null on failure.
 */
async function validateCognitoAuth(
  query: Record<string, string>,
): Promise<AuthResult | null> {
  const token = query['token']
  if (!token) {
    logger.warn(
      { queryKeys: Object.keys(query) },
      'ws-connect: validateCognitoAuth called with empty token',
    )
    return null
  }

  // Surface a few token characteristics (NOT the token itself) to debug
  // why the upgrade path is rejecting valid-looking JWTs in production.
  // [Engineer-Principal · Opus · run-final-100]
  logger.info(
    { tokenLen: token.length, tokenPrefix: token.slice(0, 12) + '…' },
    'ws-connect: validateCognitoAuth called',
  )

  const result = await verifyCognitoJwt(token)
  if (!result.ok) {
    logger.warn({ code: result.code }, 'ws-connect: Cognito JWT validation failed')
    return null
  }

  const identity: CognitoIdentity = result.identity
  return {
    installId: identity.sub, // browser connections use sub as installId
    tenantId: identity.tenantId,
    userId: identity.email ?? identity.sub,
    kind: 'cognito',
  }
}

/**
 * Validate a PKI envelope passed as install_id / sig / sig_body query params.
 * Returns an AuthResult on success, null on failure.
 */
async function validatePkiAuth(
  query: Record<string, string>,
): Promise<AuthResult | null> {
  const installId = query['install_id']
  if (!installId) return null

  const result = await verifyWsHandshake({ query })
  if (!result.ok) {
    logger.warn({ code: result.code, detail: result.detail }, 'ws-connect: PKI envelope validation failed')
    return null
  }

  return {
    installId: result.identity.installId,
    tenantId: result.identity.tenantId,
    kind: 'pki',
  }
}

/**
 * Validate authentication from the WebSocket connect event.
 * Tries Cognito first (browser path), then PKI (install path).
 */
async function validateAuth(event: APIGatewayWebSocketEvent): Promise<AuthResult | null> {
  const query = (event.queryStringParameters ?? {}) as Record<string, string>

  // Cognito path: browser client passes ?token=<jwt>
  if (query['token']) {
    return validateCognitoAuth(query)
  }

  // PKI path: install client passes ?install_id=<id>&sig=<b64>&sig_body=<b64>
  if (query['install_id']) {
    return validatePkiAuth(query)
  }

  logger.warn('ws-connect: no auth credentials in query string')
  return null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const CONNECTION_TTL_SECONDS = 2 * 60 * 60 // 2 hours

export const handler = async (event: APIGatewayWebSocketEvent): Promise<ConnectResult> => {
  const connectionId = event.requestContext.connectionId
  const sourceIp = event.requestContext.identity?.sourceIp ?? 'unknown'

  logger.debug({ connectionId, sourceIp }, 'ws-connect: received $connect')

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  const auth = await validateAuth(event)

  if (!auth) {
    logger.warn({ connectionId, sourceIp }, 'ws-connect: auth failed — rejecting connection')
    return { statusCode: 401, body: 'Unauthorized' }
  }

  logger.debug(
    { connectionId, installId: auth.installId, tenantId: auth.tenantId, kind: auth.kind },
    'ws-connect: auth accepted',
  )

  // ------------------------------------------------------------------
  // Write DynamoDB connection row
  // ------------------------------------------------------------------
  const nowMs = Date.now()
  const expiresAt = Math.floor(nowMs / 1000) + CONNECTION_TTL_SECONDS

  const connectionsTable = process.env['CONNECTIONS_TABLE']
  if (!connectionsTable) {
    logger.error('ws-connect: CONNECTIONS_TABLE env var not set')
    return { statusCode: 500, body: 'Internal Server Error' }
  }

  const putInput: PutItemCommandInput = {
    TableName: connectionsTable,
    Item: {
      connection_id: { S: connectionId },
      install_id: { S: auth.installId },
      tenant_id: { S: auth.tenantId },
      auth_kind: { S: auth.kind },
      // Empty subscriptions list stored as empty string set placeholder.
      // DynamoDB does not allow empty sets; we use a placeholder list.
      subscriptions: { L: [] },
      connected_at: { N: String(nowMs) },
      expires_at: { N: String(expiresAt) },
      ...(auth.userId ? { user_id: { S: auth.userId } } : {}),
    },
    // Condition: don't overwrite if there's already a live connection
    // with this ID (connection IDs are unique per API GW, so this is
    // defensive). No condition expression for simplicity — API GW
    // guarantees connectionId uniqueness within an API.
  }

  try {
    await getDdbClient().send(new PutItemCommand(putInput))
    logger.info(
      { connectionId, installId: auth.installId, tenantId: auth.tenantId, kind: auth.kind },
      'ws-connect: connection row written',
    )
  } catch (err) {
    logger.error({ connectionId, err }, 'ws-connect: DynamoDB putItem failed')
    return { statusCode: 500, body: 'Internal Server Error' }
  }

  return { statusCode: 200 }
}

// ---------------------------------------------------------------------------
// Test hook — reset the DDB client (allows test isolation)
// ---------------------------------------------------------------------------

export function _resetDdbClientForTests(): void {
  _ddbClient = null
}
