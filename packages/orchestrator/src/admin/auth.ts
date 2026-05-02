/**
 * admin/auth.ts — Admin token verification.
 *
 * Phase: v1 (token-gated). Future phases will replace this with a
 * capability-bundle check once user sessions carry capability bundles.
 *
 * Resolution order for the configured admin token (highest priority first):
 *   1. Keychain entry `admin.api_token` (rotatable from the admin UI in v2)
 *   2. Env var `ADMIN_TOKEN` (fallback; used for first-boot or CI)
 *
 * Open dev mode:
 *   When NODE_ENV=development AND neither keychain entry nor ADMIN_TOKEN env
 *   var is set, the admin endpoints are open. This is logged loudly at the
 *   first such access. Production deployments MUST set ADMIN_TOKEN or
 *   provision the keychain entry.
 *
 * Token transport:
 *   The admin token is passed as the `adminToken` input field of every
 *   protected mutation/query. We do NOT use HTTP headers because the
 *   project's tRPC createContext (in src/index.ts, owned by another agent)
 *   currently returns {} — it does not surface request headers. Encoding
 *   the token in the input keeps the auth boundary on this side of the
 *   wire without touching files we don't own. Future versions can switch
 *   to a header-based scheme once createContext is extended.
 *
 * No mock data, no test fixtures — real keychain via getKeychain(), real
 * env loading via process.env.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { getKeychain } from '../capabilities/keychain.js'
import { logger } from '../config/logger.js'
import type { AdminAuthDecision } from './types.js'

export const ADMIN_TOKEN_KEYCHAIN_ACCOUNT = 'admin.api_token'

/**
 * The header name future versions will use once createContext can surface
 * request headers. Kept here as a one-source-of-truth constant so the UI
 * client and server agree on the wire format on day one of that change.
 */
export const ADMIN_TOKEN_HEADER = 'x-orbital-admin-token'

/**
 * Input field name attached to every admin procedure for v1 transport.
 * Frontend passes `{ adminToken: <secret>, ...input }`; middleware strips
 * this before forwarding to the procedure body.
 */
export const ADMIN_TOKEN_INPUT_FIELD = 'adminToken'

let _openModeWarningEmitted = false

/**
 * Resolve the configured admin token.
 *
 * Returns `null` when no token is configured (caller decides whether to
 * fall through to open dev mode or deny).
 */
export async function resolveConfiguredAdminToken(): Promise<string | null> {
  // 1. Keychain
  try {
    const keychain = await getKeychain()
    const fromKeychain = await keychain.getPassword(ADMIN_TOKEN_KEYCHAIN_ACCOUNT)
    if (fromKeychain && fromKeychain.length > 0) return fromKeychain
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'admin/auth: keychain lookup failed; falling back to env',
    )
  }

  // 2. Env
  const fromEnv = process.env['ADMIN_TOKEN']
  if (fromEnv && fromEnv.length > 0) return fromEnv

  return null
}

/**
 * Compare two strings in constant time. Returns false when lengths differ
 * without a side-channel.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still spend roughly the same time so timing attacks against length cannot
    // distinguish the early-return path. Hashing both sides into fixed-length
    // buffers and comparing handles the length-mismatch case in constant time.
    const ha = createHash('sha256').update(a).digest()
    const hb = createHash('sha256').update(b).digest()
    return timingSafeEqual(ha, hb) && false
  }
  const aBuf = Buffer.from(a, 'utf-8')
  const bBuf = Buffer.from(b, 'utf-8')
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

/**
 * Decide whether an admin request is authorized.
 *
 * Inputs:
 *   - `headerToken`  — value of the `x-orbital-admin-token` header (may be undefined)
 *   - `nodeEnv`      — NODE_ENV (used for open dev mode)
 *
 * Logic:
 *   - If a token is configured (keychain or env) AND it matches the provided token → AUTH_OK
 *   - If a token is configured AND no token was provided → AUTH_MISSING_TOKEN
 *   - If a token is configured AND the provided token does not match → AUTH_BAD_TOKEN
 *   - If NO token is configured AND nodeEnv === 'development' → AUTH_OPEN_DEV
 *   - If NO token is configured AND nodeEnv !== 'development' → AUTH_MISSING_TOKEN
 *
 * Open-dev access logs a loud warning the first time it happens per process.
 */
export async function authorizeAdminRequest(
  headerToken: string | undefined,
  nodeEnv: string,
): Promise<AdminAuthDecision> {
  const configured = await resolveConfiguredAdminToken()

  if (configured !== null) {
    if (!headerToken || headerToken.length === 0) {
      return {
        allowed: false,
        reasonCode: 'AUTH_MISSING_TOKEN',
        detail: 'admin token required; set the x-orbital-admin-token header',
      }
    }
    const ok = constantTimeEqual(headerToken, configured)
    if (!ok) {
      return {
        allowed: false,
        reasonCode: 'AUTH_BAD_TOKEN',
        detail: 'admin token did not match the configured token',
      }
    }
    return { allowed: true, reasonCode: 'AUTH_OK' }
  }

  // No token configured.
  if (nodeEnv === 'development') {
    if (!_openModeWarningEmitted) {
      logger.warn(
        'admin/auth: OPEN DEV MODE — no admin token configured. ' +
          'Set ADMIN_TOKEN env var or the keychain entry "admin.api_token" before deploying.',
      )
      _openModeWarningEmitted = true
    }
    return { allowed: true, reasonCode: 'AUTH_OPEN_DEV' }
  }

  return {
    allowed: false,
    reasonCode: 'AUTH_MISSING_TOKEN',
    detail:
      'no admin token is configured and NODE_ENV is not development; ' +
      'set ADMIN_TOKEN or the keychain entry "admin.api_token"',
  }
}

/** Test helper — clears the per-process "open mode warning emitted" flag. */
export function _resetOpenModeWarning(): void {
  _openModeWarningEmitted = false
}
