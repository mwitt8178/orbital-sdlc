/**
 * hub-client/auth.ts — Local-side outbound signer.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Wraps every HTTP request from the local install to the hub with a signed
 * envelope. Loads the install keypair lazily on first use (or generates one
 * if `~/.orbital/keys/install.json` doesn't exist yet — which means the
 * install hasn't joined a hub yet, and the call is going to fail at the hub
 * with INSTALL_UNKNOWN, but we still sign so the failure mode is
 * "AUTH_INSTALL_UNKNOWN" rather than "AUTH_HEADER_MISSING").
 *
 * Hub-client integration: hub-client/client.ts calls `attachAuthHeaders(headers,
 * method, body)` before fetch. The signer is a process-singleton bound to
 * the install key on disk. Test hooks let us swap the key for parallel
 * isolation.
 */

import {
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
  signEnvelope,
} from '../keys/envelope.js'
import { getOrCreateInstallKey, type InstallKey } from '../keys/install-key.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Singleton install key — loaded once per process
// ---------------------------------------------------------------------------

let _cachedKey: InstallKey | null = null
let _customKeyPath: string | undefined

/**
 * Set a custom key path for tests. Resets the cache.
 */
export function _setInstallKeyPath(filePath: string | undefined): void {
  _customKeyPath = filePath
  _cachedKey = null
}

/**
 * Reset the cached install key — tests only.
 */
export function _resetCachedInstallKey(): void {
  _cachedKey = null
}

async function getKey(): Promise<InstallKey> {
  if (_cachedKey) return _cachedKey
  _cachedKey = await getOrCreateInstallKey(
    _customKeyPath ? { filePath: _customKeyPath } : {},
  )
  // Log only safe fingerprint bytes
  const fingerprint = Buffer.from(_cachedKey.publicKey).toString('hex').slice(0, 16)
  logger.info(
    { installId: _cachedKey.installId, fingerprint },
    'hub-client/auth: install key loaded',
  )
  return _cachedKey
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SignedHeaders {
  [HEADER_INSTALL_ID]: string
  [HEADER_SIG]: string
  [HEADER_SIG_BODY]: string
}

/**
 * Build the X-Orbital-* headers for a request to the hub.
 *
 * @param method  RPC method or HTTP path being signed (e.g. "tasks.list")
 * @param bodyBytes  Raw request body bytes (Uint8Array). Empty buffer for no body.
 */
export async function buildSignedHeaders(
  method: string,
  bodyBytes: Uint8Array,
): Promise<SignedHeaders> {
  const key = await getKey()
  const env = await signEnvelope({
    method,
    bodyBytes,
    privateKey: key.privateKey,
  })
  return {
    [HEADER_INSTALL_ID]: key.installId,
    [HEADER_SIG]: env.signatureB64,
    [HEADER_SIG_BODY]: env.bodyB64,
  }
}

/**
 * attachAuthHeaders — convenience that mutates a headers record in-place.
 * Used by the existing hub-client.ts which builds a `headers` object before
 * calling fetch().
 */
export async function attachAuthHeaders(
  headers: Record<string, string>,
  method: string,
  bodyBytes: Uint8Array,
): Promise<void> {
  const signed = await buildSignedHeaders(method, bodyBytes)
  for (const [k, v] of Object.entries(signed)) {
    headers[k] = v
  }
}

/**
 * Get the install_id of the current local install. Useful for telemetry / UX.
 */
export async function getLocalInstallId(): Promise<string> {
  const key = await getKey()
  return key.installId
}

/**
 * Get the public key of the current local install (base64url). Useful for the
 * `orbital join` CLI which needs to send this to the hub.
 */
export async function getLocalPublicKeyB64(): Promise<string> {
  const key = await getKey()
  // We have raw bytes; convert via the same base64url helper
  const { bytesToBase64Url } = await import('../keys/envelope.js')
  return bytesToBase64Url(key.publicKey)
}
