/**
 * @orbital/api-lambda — Lambda entry.
 *
 * Wires API Gateway HTTP API v2 events to the narrow `lambdaAppRouter`.
 * Cold-import side-effect-free — the router constructs lazily on first
 * request via `getLambdaAppRouter()`.
 *
 * IMPORTANT — IAM token freshness:
 *   RDS Proxy IAM tokens are valid 15 min. The api-lambda is held warm by
 *   PC, so a single warm container can outlive the token. To avoid every
 *   call after the 15-min mark dying with "IAM authentication failed":
 *     1. `initOnce()` (init.ts) tracks `_initializedAt`; at the 12-min
 *        mark it returns a NEW db client and resets `_router` so service
 *        wiring rebinds.
 *     2. THIS file caches `_wrapped` (the awsLambdaRequestHandler) tied
 *        to a specific db reference. Each request checks if the cached
 *        wrapped's db matches the one initOnce returns; if not, drop
 *        `_wrapped` and rebuild. Without this, `_wrapped` keeps the OLD
 *        router and OLD db forever even after init.ts has refreshed.
 */

import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda'
import type { APIGatewayProxyEventV2WithRequestContext } from 'aws-lambda'

import { getLambdaAppRouter } from './router.js'
import { initOnce, getGithubAppWebhookSecret } from './init.js'
// GitHub App webhook receiver — explicit Lambda-native handler at
// POST /webhooks/github. Verifies the X-Hub-Signature-256 HMAC, dedupes by
// X-GitHub-Delivery, and persists a row to github_webhook_deliveries.
// [Engineer-Principal · Opus · run-orbital-github-integration]
import { verifyWebhookSignature } from '../../orchestrator/src/github/app-auth.js'
import { githubWebhookDeliveries } from '@orbital/db'
import { createHash } from 'node:crypto'

interface AuthClaims {
  tenantId: string | undefined
  userId: string | undefined
  email: string | undefined
  role: string | undefined
}

function extractAuth(event: APIGatewayProxyEventV2WithRequestContext<unknown>): AuthClaims {
  const authorizer = (
    event.requestContext as {
      authorizer?: {
        jwt?: { claims?: Record<string, string | undefined> }
      }
    }
  ).authorizer

  const claims = authorizer?.jwt?.claims
  if (!claims) {
    return { tenantId: undefined, userId: undefined, email: undefined, role: undefined }
  }
  const tenantId = claims['custom:tenant_id'] ?? claims['tenant_id']
  return {
    tenantId,
    userId: claims['sub'],
    email: claims['email'],
    role: claims['custom:role'],
  }
}

/**
 * Emit a single structured JSON log line to stdout for CloudWatch metric filters.
 * No pino dep needed — Lambda stdout is ingested as-is by CloudWatch Logs.
 * Never log token contents, passwords, or secret values.
 */
function structuredLog(fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...fields, ts: new Date().toISOString() }))
}

let _wrapped: ReturnType<typeof awsLambdaRequestHandler> | null = null
// Identity check — when initOnce returns a fresh db reference, we
// rebuild _wrapped. Comparing references catches the IAM refresh.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _wrappedDb: any = null

async function getWrappedHandler(requestId?: string): Promise<ReturnType<typeof awsLambdaRequestHandler>> {
  // Always run initOnce — it's cheap when fresh (single ref check) and
  // returns a NEW db reference when the 12-min refresh fires.
  const { db, secrets } = await initOnce(requestId)
  if (_wrapped && _wrappedDb === db) return _wrapped
  // Either first call OR db got refreshed under us — rebuild.
  const router = await getLambdaAppRouter()
  _wrapped = awsLambdaRequestHandler({
    router,
    createContext: ({ event }) => {
      const auth = extractAuth(event as APIGatewayProxyEventV2WithRequestContext<unknown>)
      return {
        ...auth,
        db,
        secrets,
        req: {
          headers: ((event as { headers?: Record<string, string> }).headers ?? {}) as Record<
            string,
            string | undefined
          >,
        },
      }
    },
  })
  _wrappedDb = db
  return _wrapped
}

// ---------------------------------------------------------------------------
// GitHub webhook receiver — POST /webhooks/github
// ---------------------------------------------------------------------------

interface ApiGwHttpEvent {
  rawPath?: string
  requestContext?: { http?: { method?: string; path?: string } }
  body?: string
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
}

function isGithubWebhookEvent(event: unknown): event is ApiGwHttpEvent {
  const e = event as ApiGwHttpEvent | undefined
  if (!e) return false
  const path = e.rawPath ?? e.requestContext?.http?.path
  const method = e.requestContext?.http?.method
  return path === '/webhooks/github' && (method === undefined || method === 'POST')
}

async function handleGithubWebhook(event: ApiGwHttpEvent, requestId?: string): Promise<{
  statusCode: number
  headers: Record<string, string>
  body: string
}> {
  const headers = event.headers ?? {}
  const signature = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256']
  const githubEvent = headers['x-github-event'] ?? headers['X-GitHub-Event']
  const deliveryId = headers['x-github-delivery'] ?? headers['X-GitHub-Delivery']
  const action = (() => {
    try {
      const parsed = event.body ? JSON.parse(rawBody(event)) : null
      return parsed && typeof parsed === 'object' && typeof (parsed as { action?: unknown }).action === 'string'
        ? (parsed as { action: string }).action
        : undefined
    } catch {
      return undefined
    }
  })()

  function jsonResponse(status: number, body: Record<string, unknown>) {
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  }

  if (!signature) {
    return jsonResponse(401, {
      error: { code: 'WEBHOOK_INVALID_SIGNATURE', message: 'missing x-hub-signature-256' },
    })
  }

  let secret: string
  try {
    secret = await getGithubAppWebhookSecret()
  } catch (err) {
    structuredLog({
      event: 'webhook_secret_unavailable',
      reason: err instanceof Error ? err.message : String(err),
      ...(requestId ? { requestId } : {}),
    })
    // 503 — operator must register the App and create the secret.
    return jsonResponse(503, {
      error: {
        code: 'GITHUB_APP_NOT_REGISTERED',
        message: 'GitHub App webhook secret not configured',
      },
    })
  }

  const raw = rawBody(event)
  if (!verifyWebhookSignature(raw, signature, secret)) {
    structuredLog({
      event: 'webhook_invalid_signature',
      githubEvent,
      ...(requestId ? { requestId } : {}),
    })
    return jsonResponse(401, {
      error: { code: 'WEBHOOK_INVALID_SIGNATURE', message: 'invalid x-hub-signature-256' },
    })
  }

  // Persist delivery + idempotent dedupe via PRIMARY KEY (delivery_id).
  const { db } = await initOnce(requestId)
  const payloadSha = createHash('sha256').update(raw).digest('hex')

  if (deliveryId) {
    try {
      await db.insert(githubWebhookDeliveries).values({
        deliveryId,
        eventType: githubEvent ?? 'unknown',
        action: action ?? null,
        payloadSha256: payloadSha,
        result: 'ok',
      })
    } catch (err) {
      // Conflict on PK = duplicate delivery; return 200 so GitHub stops retrying.
      const msg = err instanceof Error ? err.message : String(err)
      if (/duplicate key|unique/i.test(msg)) {
        structuredLog({
          event: 'webhook_duplicate_delivery',
          deliveryId,
          githubEvent,
          ...(requestId ? { requestId } : {}),
        })
        return jsonResponse(200, { ok: true, skipped: 'duplicate' })
      }
      throw err
    }
  }

  structuredLog({
    event: 'webhook_received',
    githubEvent,
    action,
    deliveryId,
    payloadSha256: payloadSha,
    ...(requestId ? { requestId } : {}),
  })

  // Event-routing (PR/check_run/etc.) is performed by an async consumer in a
  // follow-up phase. For now the receive-and-persist path is the contract.
  return jsonResponse(200, { ok: true })
}

function rawBody(event: ApiGwHttpEvent): string {
  if (!event.body) return ''
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf-8')
  return event.body
}

// API Gateway calls this entry. Lambda runtime accepts a function returning
// either Promise<APIGatewayProxyResult> or Promise<APIGatewayProxyResultV2>.
// We delegate to the awsLambdaRequestHandler which produces v2-shaped output.
export const handler = async (
  event: unknown,
  context: unknown,
  callback: unknown,
): Promise<unknown> => {
  // Extract requestId from Lambda context for structured log correlation.
  const requestId = (context as { awsRequestId?: string } | null)?.awsRequestId

  // GitHub webhook — bypass tRPC entirely.
  if (isGithubWebhookEvent(event)) {
    try {
      return await handleGithubWebhook(event, requestId)
    } catch (err) {
      structuredLog({
        event: 'webhook_handler_error',
        reason: err instanceof Error ? err.message : String(err),
        ...(requestId ? { requestId } : {}),
      })
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'WEBHOOK_HANDLER_ERROR', message: 'see CloudWatch logs' },
        }),
      }
    }
  }

  try {
    const wrapped = await getWrappedHandler(requestId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (wrapped as any)(event, context, callback)
  } catch (err) {
    // Last-ditch: if a request still hits "IAM authentication failed"
    // because the postgres connection broke between cache check and
    // actual query, drop both caches and let the next request rebuild.
    const msg = err instanceof Error ? err.message : String(err)
    if (/IAM authentication failed/i.test(msg)) {
      // Emit structured log BEFORE clearing caches so the alarm fires.
      // Do NOT log the error message itself — it may contain partial token
      // fragments or connection strings. Log only the event type + requestId.
      structuredLog({
        event: 'iam_auth_failed',
        ...(requestId ? { requestId } : {}),
      })
      _wrapped = null
      _wrappedDb = null
      // Re-throw so API GW returns 500 — the client will retry and the
      // next request gets a fresh token.
    }
    throw err
  }
}
