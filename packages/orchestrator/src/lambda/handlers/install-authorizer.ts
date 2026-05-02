/**
 * lambda/handlers/install-authorizer.ts — API Gateway Lambda authorizer
 * for install-to-hub PKI envelope authentication.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * This is a Lambda authorizer (not a tRPC handler). It implements the
 * simple response format for API Gateway HTTP API Lambda authorizers.
 *
 * Protocol:
 *   Headers verified:
 *     X-Orbital-Install-Id  — UUID identifying the sender install
 *     X-Orbital-Sig-Body    — base64url canonical JSON of EnvelopeBody
 *     X-Orbital-Sig         — base64url Ed25519 signature over bodyBytes
 *
 *   On success: returns { isAuthorized: true, context: { installId, tenantId, role } }
 *   On failure: returns { isAuthorized: false }
 *
 * Verification steps (per keys/envelope.ts):
 *   1. Decode X-Orbital-Sig-Body, parse EnvelopeBody JSON
 *   2. Verify timestamp within ±60s (clock drift check)
 *   3. Verify nonce has not been seen in the last 5 min (replay protection)
 *   4. Verify params_hash matches sha256 of request body bytes
 *   5. Look up known_installs row by install_id + tenant; verify revoked_at IS NULL
 *   6. Verify Ed25519 signature against known_installs.public_key
 *
 * Replay protection:
 *   NonceLru is module-scope (per-container) — bounded at 10k entries, 5-min TTL.
 *   This is sufficient for the expected Lambda concurrency. Nonces that survive
 *   the 5-min TTL are blocked anyway by the ts ±60s check.
 *
 * Multi-tenant isolation:
 *   tenantId is resolved from the install's DB row (never from request headers).
 *   The DB lookup is the trust boundary for tenant attribution.
 *
 * Performance:
 *   DB is initialized via initOnce() on cold start and reused across warm
 *   invocations. Authorizer cache TTL = 0 in API GW config (no caching) because
 *   nonces are single-use. Each request hits this Lambda.
 */

import type {
  APIGatewayRequestSimpleAuthorizerHandlerV2,
  APIGatewaySimpleAuthorizerResult,
} from 'aws-lambda'
import { eq } from 'drizzle-orm'
import {
  verifyEnvelope,
  NonceLru,
  base64UrlToBytes,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
} from '../../keys/envelope.js'
import { initOnce } from '../init.js'

// ---------------------------------------------------------------------------
// Module-scope nonce LRU — persists across warm invocations
// ---------------------------------------------------------------------------
const nonceLru = new NonceLru({ capacity: 10_000, ttlMs: 5 * 60 * 1000 })

// ---------------------------------------------------------------------------
// Result shape helpers
// ---------------------------------------------------------------------------

function deny(reason: string): APIGatewaySimpleAuthorizerResult {
  // Log at warn level for CloudWatch; reason is internal-only
  // eslint-disable-next-line no-console
  console.warn(`[install-authorizer] DENY: ${reason}`)
  return { isAuthorized: false }
}

function allow(context: {
  installId: string
  tenantId: string
  role: string
}): APIGatewaySimpleAuthorizerResult {
  return {
    isAuthorized: true,
    context,
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (event) => {
  // ------------------------------------------------------------------
  // 0. Initialize DB (cold start: generates IAM token, connects)
  // ------------------------------------------------------------------
  const { db } = await initOnce()

  // ------------------------------------------------------------------
  // 1. Extract required headers
  // ------------------------------------------------------------------
  const headers = event.headers ?? {}
  const installId = headers[HEADER_INSTALL_ID] ?? headers[HEADER_INSTALL_ID.toLowerCase()]
  const sigBody = headers[HEADER_SIG_BODY] ?? headers[HEADER_SIG_BODY.toLowerCase()]
  const sig = headers[HEADER_SIG] ?? headers[HEADER_SIG.toLowerCase()]

  if (!installId || !sigBody || !sig) {
    return deny(`missing required headers: installId=${!!installId} sigBody=${!!sigBody} sig=${!!sig}`)
  }

  // ------------------------------------------------------------------
  // 2. Decode request body bytes (for params_hash verification)
  // ------------------------------------------------------------------
  let requestBodyBytes: Uint8Array
  try {
    const rawBody = event.body ?? ''
    requestBodyBytes = new TextEncoder().encode(rawBody)
  } catch {
    return deny('failed to encode request body')
  }

  // ------------------------------------------------------------------
  // 3. Look up install in known_installs (resolves tenantId + publicKey)
  // ------------------------------------------------------------------
  // Dynamic import to avoid importing schema at module load (better cold start)
  const { knownInstalls } = await import('../../db/schema/known-installs.js')

  let installRow: {
    tenant_id: string
    public_key: string
    role: string
    revoked_at: Date | null
  } | undefined

  try {
    const rows = await db
      .select({
        tenant_id: knownInstalls.tenant_id,
        public_key: knownInstalls.public_key,
        role: knownInstalls.role,
        revoked_at: knownInstalls.revoked_at,
      })
      .from(knownInstalls)
      .where(eq(knownInstalls.install_id, installId))
      .limit(1)

    installRow = rows[0] as typeof installRow
  } catch (err) {
    // DB error — deny but log for diagnostics
    // eslint-disable-next-line no-console
    console.error('[install-authorizer] DB lookup error:', err)
    return deny('db lookup failed')
  }

  if (!installRow) {
    return deny(`INSTALL_UNKNOWN: installId=${installId}`)
  }

  if (installRow.revoked_at !== null) {
    return deny(`INSTALL_REVOKED: installId=${installId} revokedAt=${installRow.revoked_at.toISOString()}`)
  }

  // ------------------------------------------------------------------
  // 4. Verify envelope signature
  // ------------------------------------------------------------------
  let publicKeyBytes: Uint8Array
  try {
    publicKeyBytes = base64UrlToBytes(installRow.public_key)
  } catch {
    return deny('public_key decode failed')
  }

  const verifyResult = await verifyEnvelope({
    publicKey: publicKeyBytes,
    bodyB64: sigBody,
    signatureB64: sig,
    requestBodyBytes,
  })

  if (!verifyResult.ok) {
    return deny(`${verifyResult.code}: ${verifyResult.detail}`)
  }

  // ------------------------------------------------------------------
  // 5. Replay protection — check nonce uniqueness
  // ------------------------------------------------------------------
  const nonce = verifyResult.body.nonce
  const isFresh = nonceLru.recordIfFresh(nonce)
  if (!isFresh) {
    return deny(`AUTH_REPLAY: nonce=${nonce}`)
  }

  // ------------------------------------------------------------------
  // 6. Authorized — return context injected into tRPC handler
  // ------------------------------------------------------------------
  return allow({
    installId,
    tenantId: installRow.tenant_id,
    role: installRow.role,
  })
}
