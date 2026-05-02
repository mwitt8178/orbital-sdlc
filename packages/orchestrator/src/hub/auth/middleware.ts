/**
 * hub/auth/middleware.ts — Envelope verification middleware (hub-side).
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Validates the X-Orbital-Install-Id / X-Orbital-Sig / X-Orbital-Sig-Body
 * triplet on every protected route. Returns a discriminated union:
 *
 *   { ok: true, identity }   — caller injects identity into ctx
 *   { ok: false, code, ... } — caller emits 401 with the code
 *
 * Codes (stable wire contract):
 *   - AUTH_HEADER_MISSING       — required header(s) absent
 *   - AUTH_BODY_MALFORMED       — sig-body not valid base64url JSON
 *   - AUTH_TS_EXPIRED           — clock skew > 60s
 *   - AUTH_REPLAY               — nonce already seen in window
 *   - AUTH_PARAMS_MISMATCH      — body sha256 ≠ asserted params_hash
 *   - AUTH_SIG_INVALID          — Ed25519 verify failed
 *   - INSTALL_UNKNOWN           — install_id not in known_installs
 *   - INSTALL_REVOKED           — install_id has revoked_at IS NOT NULL
 *
 * Flow (per request):
 *   1. Pull headers; reject if missing → AUTH_HEADER_MISSING.
 *   2. Look up install in known_installs → INSTALL_UNKNOWN / INSTALL_REVOKED.
 *   3. verifyEnvelope(...) against the install's public key.
 *   4. Check nonce LRU; AUTH_REPLAY if seen.
 *   5. Best-effort touchLastSeen() — never blocks the request.
 *   6. Return ctx { installId, tenantId, role, displayName }.
 */

import {
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
  NonceLru,
  base64UrlToBytes,
  verifyEnvelope,
  type AuthErrorCode,
} from '../../keys/envelope.js'
import { logger } from '../../config/logger.js'
import { getInstallById, touchLastSeen, type InstallIdentity } from './known-installs.js'

export type AuthMiddlewareErrorCode = AuthErrorCode | 'AUTH_HEADER_MISSING'

export interface AuthMiddlewareOk {
  ok: true
  identity: InstallIdentity
}

export interface AuthMiddlewareErr {
  ok: false
  code: AuthMiddlewareErrorCode
  detail: string
}

export type AuthMiddlewareResult = AuthMiddlewareOk | AuthMiddlewareErr

export interface AuthMiddlewareOptions {
  headers: Record<string, string | string[] | undefined>
  /** Raw HTTP request body bytes (Uint8Array; empty buffer if no body). */
  requestBodyBytes: Uint8Array
  /** Override clock — tests only. */
  nowMs?: number
  /** Allowed clock drift in ms (default 60_000). */
  maxDriftMs?: number
  /** Optional NonceLru (defaults to module-level singleton). */
  nonceLru?: NonceLru
}

// ---------------------------------------------------------------------------
// Module-level nonce LRU singleton
// ---------------------------------------------------------------------------

let _nonceLru: NonceLru | null = null

export function getNonceLru(): NonceLru {
  if (!_nonceLru) {
    _nonceLru = new NonceLru({ capacity: 50_000, ttlMs: 5 * 60 * 1000 })
  }
  return _nonceLru
}

/** Test-only — replace the singleton (e.g. for clean isolation). */
export function _resetNonceLru(): void {
  _nonceLru = null
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0] ?? null
      if (typeof v === 'string') return v
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Main verify function
// ---------------------------------------------------------------------------

/**
 * Verify a request's signed envelope and resolve the install identity.
 *
 * Pure function — does not perform I/O beyond DB lookup. Caller is
 * responsible for translating the result into HTTP status / tRPC error.
 */
export async function verifyRequest(
  opts: AuthMiddlewareOptions,
): Promise<AuthMiddlewareResult> {
  const installId = pickHeader(opts.headers, HEADER_INSTALL_ID)
  const sigB64 = pickHeader(opts.headers, HEADER_SIG)
  const bodyB64 = pickHeader(opts.headers, HEADER_SIG_BODY)

  if (!installId || !sigB64 || !bodyB64) {
    return {
      ok: false,
      code: 'AUTH_HEADER_MISSING',
      detail: `required headers missing (${HEADER_INSTALL_ID}/${HEADER_SIG}/${HEADER_SIG_BODY})`,
    }
  }

  // Look up the install
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

  // Decode the install's stored public key
  let publicKeyBytes: Uint8Array
  try {
    publicKeyBytes = base64UrlToBytes(identity.publicKey)
  } catch (err) {
    logger.error(
      { installId, err },
      'auth-middleware: stored public_key is malformed (db corruption)',
    )
    return {
      ok: false,
      code: 'AUTH_SIG_INVALID',
      detail: 'stored public key malformed',
    }
  }

  // Verify the envelope (sig + ts + params_hash)
  const verify = await verifyEnvelope({
    publicKey: publicKeyBytes,
    bodyB64,
    signatureB64: sigB64,
    requestBodyBytes: opts.requestBodyBytes,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.maxDriftMs !== undefined ? { maxDriftMs: opts.maxDriftMs } : {}),
  })

  if (!verify.ok) {
    return { ok: false, code: verify.code, detail: verify.detail }
  }

  // Replay protection
  const lru = opts.nonceLru ?? getNonceLru()
  const now = opts.nowMs ?? Date.now()
  if (!lru.recordIfFresh(verify.body.nonce, now)) {
    return {
      ok: false,
      code: 'AUTH_REPLAY',
      detail: `nonce ${verify.body.nonce.slice(0, 8)}… already seen in window`,
    }
  }

  // Best-effort last-seen update; failure is logged but does not fail the request.
  void touchLastSeen(installId).catch((err) => {
    logger.warn({ err, installId }, 'auth-middleware: touchLastSeen failed')
  })

  return { ok: true, identity }
}

// ---------------------------------------------------------------------------
// Maps wire-error code → HTTP status
// ---------------------------------------------------------------------------

export function authErrorToHttpStatus(code: AuthMiddlewareErrorCode): number {
  switch (code) {
    case 'AUTH_HEADER_MISSING':
    case 'INSTALL_UNKNOWN':
    case 'INSTALL_REVOKED':
    case 'AUTH_SIG_INVALID':
    case 'AUTH_BODY_MALFORMED':
    case 'AUTH_TS_EXPIRED':
    case 'AUTH_REPLAY':
    case 'AUTH_PARAMS_MISMATCH':
      return 401
    default:
      return 401
  }
}
