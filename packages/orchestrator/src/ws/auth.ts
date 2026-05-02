/**
 * ws/auth.ts — WS handshake envelope verification (hub-mode).
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * When ORBITAL_MODE=hub, WS upgrades must present a signed envelope in
 * query-string parameters (can't set custom headers on browser WebSocket).
 *
 * Query parameters expected:
 *   install_id  — the UUID of the connecting install
 *   sig         — base64url Ed25519 signature over the canonical envelope body
 *   sig_body    — base64url canonical JSON of the envelope body
 *
 * The "method" signed over is always 'ws.connect'. The body bytes are empty
 * (no request body on a WS upgrade).
 *
 * On failure, the hub sends WS close code 4001 with reason 'AUTH_REQUIRED'.
 * This matches the AC5 requirement.
 *
 * Reuses:
 *   - keys/envelope.ts verifyEnvelope() + NonceLru
 *   - hub/auth/known-installs.ts getInstallById()
 */

import {
  HEADER_INSTALL_ID as _,
  NonceLru,
  verifyEnvelope,
  base64UrlToBytes,
} from '../keys/envelope.js'
import { getInstallById, type InstallIdentity } from '../hub/auth/known-installs.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsHandshakeOk {
  ok: true
  identity: InstallIdentity
}

export interface WsHandshakeErr {
  ok: false
  code: string
  detail: string
}

export type WsHandshakeResult = WsHandshakeOk | WsHandshakeErr

// ---------------------------------------------------------------------------
// Module-level nonce LRU (shared with HTTP middleware is fine — different
// method prefix prevents collisions, and the window is the same 5 min)
// ---------------------------------------------------------------------------

let _nonceLru: NonceLru | null = null

export function _getWsNonceLru(): NonceLru {
  if (!_nonceLru) _nonceLru = new NonceLru({ capacity: 10_000, ttlMs: 5 * 60 * 1000 })
  return _nonceLru
}

/** Test-only: reset LRU for isolation. */
export function _resetWsNonceLru(): void {
  _nonceLru = null
}

// ---------------------------------------------------------------------------
// Main verify function
// ---------------------------------------------------------------------------

export interface WsHandshakeOptions {
  /** Query parameters from the WS upgrade URL. */
  query: Record<string, string | undefined>
  /** Override Date.now() — tests only. */
  nowMs?: number
  /** Override nonce LRU — tests only. */
  nonceLru?: NonceLru
}

const WS_CONNECT_METHOD = 'ws.connect'
const EMPTY_BODY = new Uint8Array(0)

/**
 * Verify the WS handshake envelope from query string parameters.
 *
 * Returns ok=true with install identity on success;
 * ok=false with a stable code on failure.
 *
 * Never throws on normal auth failures — only on programmer errors.
 */
export async function verifyWsHandshake(opts: WsHandshakeOptions): Promise<WsHandshakeResult> {
  const { query, nowMs, nonceLru } = opts
  const installId = query['install_id']
  const sigB64 = query['sig']
  const bodyB64 = query['sig_body']

  if (!installId || !sigB64 || !bodyB64) {
    return {
      ok: false,
      code: 'AUTH_HEADER_MISSING',
      detail: 'WS upgrade missing install_id / sig / sig_body query params',
    }
  }

  // Look up install
  const identity = await getInstallById(installId)
  if (!identity) {
    return {
      ok: false,
      code: 'INSTALL_UNKNOWN',
      detail: `install_id ${installId} not registered with this hub`,
    }
  }
  if (identity.revokedAt !== null) {
    return {
      ok: false,
      code: 'INSTALL_REVOKED',
      detail: `install ${installId} was revoked at ${identity.revokedAt}`,
    }
  }

  // Decode stored public key
  let publicKeyBytes: Uint8Array
  try {
    publicKeyBytes = base64UrlToBytes(identity.publicKey)
  } catch (err) {
    logger.error({ installId, err }, 'ws-auth: stored public_key malformed')
    return { ok: false, code: 'AUTH_SIG_INVALID', detail: 'stored public key malformed' }
  }

  // Verify envelope (sig + ts + params_hash)
  // The request body for a WS connect is always empty.
  const verify = await verifyEnvelope({
    publicKey: publicKeyBytes,
    bodyB64,
    signatureB64: sigB64,
    requestBodyBytes: EMPTY_BODY,
    ...(nowMs !== undefined ? { nowMs } : {}),
  })

  if (!verify.ok) {
    logger.debug({ installId, code: verify.code }, 'ws-auth: envelope verify failed')
    return { ok: false, code: verify.code, detail: verify.detail }
  }

  // Verify method is ws.connect (prevent token reuse across contexts)
  if (verify.body.method !== WS_CONNECT_METHOD) {
    return {
      ok: false,
      code: 'AUTH_SIG_INVALID',
      detail: `expected method '${WS_CONNECT_METHOD}', got '${verify.body.method}'`,
    }
  }

  // Replay protection
  const lru = nonceLru ?? _getWsNonceLru()
  const now = nowMs ?? Date.now()
  if (!lru.recordIfFresh(verify.body.nonce, now)) {
    return {
      ok: false,
      code: 'AUTH_REPLAY',
      detail: `nonce ${verify.body.nonce.slice(0, 8)}… already seen`,
    }
  }

  logger.debug({ installId, tenantId: identity.tenantId }, 'ws-auth: handshake accepted')
  return { ok: true, identity }
}
