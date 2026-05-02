/**
 * hub/auth/registration.ts — Hub-side install registration (pairing handshake).
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Flow:
 *   1. Owner runs `orbital invite create` → mintInvite() returns a JWT signed
 *      with the hub master key (HS256 over the master secret).
 *   2. New operator runs `orbital join <invite-url>` → local POSTs
 *      { install_id, public_key, display_name, invite_token } to /hub/register.
 *   3. registerHandler() validates the JWT (sig + expiry), inserts a
 *      known_installs row (the UNIQUE INDEX on invite_jti enforces single-use),
 *      and returns { ok, tenant_id, hub_pubkey }.
 *
 * The JWT is HS256-signed with the hub master key — same secret the hub uses
 * for its own ops scripts (see scripts/hub-bootstrap.sh). HS256 is sufficient
 * here because the invite never leaves the hub→operator boundary; the operator
 * doesn't validate the JWT, they only round-trip it back to the hub for
 * verification.
 *
 * Single-use enforcement:
 *   - The DB UNIQUE INDEX on known_installs.invite_jti is the source of truth.
 *   - A reused jti → INSERT fails with 23505 → handler returns AUTH_INVITE_ALREADY_USED.
 *   - This is durable across hub restarts (unlike an in-memory seen-jti set).
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import { logger } from '../../config/logger.js'
import { registerInstall, getInstallById } from './known-installs.js'
import { bytesToBase64Url, base64UrlToBytes } from '../../keys/envelope.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteClaims {
  /** Tenant the invitee will join. */
  tenant_id: string
  /** Role the invitee receives on join. */
  role: 'owner' | 'member' | 'viewer'
  /** Issued-at, seconds since epoch. */
  iat: number
  /** Expires-at, seconds since epoch. */
  exp: number
  /** JWT id — unique per invite for single-use enforcement. */
  jti: string
}

export interface RegistrationRequest {
  install_id: string
  public_key: string
  display_name?: string | null
  invite_token: string
}

export interface RegistrationOk {
  ok: true
  install_id: string
  tenant_id: string
  role: 'owner' | 'member' | 'viewer'
  hub_pubkey: string
}

export interface RegistrationError {
  ok: false
  code:
    | 'AUTH_INVITE_INVALID'
    | 'AUTH_INVITE_EXPIRED'
    | 'AUTH_INVITE_ALREADY_USED'
    | 'AUTH_REQUEST_MALFORMED'
    | 'INTERNAL_ERROR'
  message: string
}

export type RegistrationResult = RegistrationOk | RegistrationError

// ---------------------------------------------------------------------------
// Hub master key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the hub master key (HS256 secret) from env. The hub bootstrap script
 * writes ORBITAL_HUB_MASTER_KEY at deploy time. This function throws if the
 * key is missing — hub mode without a master key is unsafe.
 */
export function resolveHubMasterKey(): string {
  const fromEnv = process.env['ORBITAL_HUB_MASTER_KEY']
  if (fromEnv && fromEnv.length >= 32) return fromEnv
  throw new Error(
    'hub-auth: ORBITAL_HUB_MASTER_KEY env var is missing or shorter than 32 chars. ' +
      'Run scripts/hub-bootstrap.sh to provision one.',
  )
}

/**
 * Hub-pubkey advertised back to operators on successful registration. We derive
 * a deterministic identifier from the master key (sha256(master)[:32] base64url)
 * so operators can pin the hub identity. NOT a cryptographic public key in the
 * Ed25519 sense; it's an identity fingerprint the operator can later compare.
 *
 * For Ed25519 hub identity (used for cross-hub federation in 9+) we'll add a
 * separate keypair in `signing_keys` with key_kind='hub'. Out of scope here.
 */
export function hubFingerprint(): string {
  const key = resolveHubMasterKey()
  const buf = createHash('sha256').update(key).digest()
  return bytesToBase64Url(new Uint8Array(buf)).slice(0, 32)
}

// ---------------------------------------------------------------------------
// JWT (HS256) — minimal, dependency-free
// ---------------------------------------------------------------------------

/**
 * Mint a new invite token (JWT HS256). Used by `orbital invite create`.
 *
 * Defaults: 24 h expiry, jti = uuidv7.
 */
export function mintInvite(opts: {
  tenantId: string
  role: 'owner' | 'member' | 'viewer'
  ttlSec?: number
  /** Override clock — tests only. */
  nowSec?: number
  /** Override jti — tests only. */
  jti?: string
}): { token: string; claims: InviteClaims } {
  const masterKey = resolveHubMasterKey()
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const ttl = opts.ttlSec ?? 24 * 60 * 60 // 24h
  const claims: InviteClaims = {
    tenant_id: opts.tenantId,
    role: opts.role,
    iat: now,
    exp: now + ttl,
    jti: opts.jti ?? uuidv7(),
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = bytesToBase64Url(Buffer.from(JSON.stringify(header)))
  const payloadB64 = bytesToBase64Url(Buffer.from(JSON.stringify(claims)))
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = createHmac('sha256', masterKey).update(signingInput).digest()
  const sigB64 = bytesToBase64Url(new Uint8Array(sig))
  return { token: `${signingInput}.${sigB64}`, claims }
}

interface VerifyInviteOk {
  ok: true
  claims: InviteClaims
}
interface VerifyInviteErr {
  ok: false
  code: 'AUTH_INVITE_INVALID' | 'AUTH_INVITE_EXPIRED'
  message: string
}

/**
 * Verify an invite token. Constant-time HMAC compare; expiry check.
 */
export function verifyInvite(
  token: string,
  opts: { nowSec?: number } = {},
): VerifyInviteOk | VerifyInviteErr {
  const masterKey = resolveHubMasterKey()
  const parts = token.split('.')
  if (parts.length !== 3) {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'malformed JWT' }
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  // Verify header
  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(Buffer.from(base64UrlToBytes(headerB64)).toString('utf-8'))
  } catch {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'header not JSON' }
  }
  if (header.alg !== 'HS256') {
    return {
      ok: false,
      code: 'AUTH_INVITE_INVALID',
      message: `unsupported alg ${header.alg ?? 'unknown'}`,
    }
  }

  // Recompute sig
  const signingInput = `${headerB64}.${payloadB64}`
  const expected = createHmac('sha256', masterKey).update(signingInput).digest()

  let provided: Buffer
  try {
    provided = Buffer.from(base64UrlToBytes(sigB64))
  } catch {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'sig not base64url' }
  }

  if (provided.length !== expected.length) {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'sig length mismatch' }
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'sig mismatch' }
  }

  // Decode payload + validate shape
  let claims: InviteClaims
  try {
    claims = JSON.parse(Buffer.from(base64UrlToBytes(payloadB64)).toString('utf-8'))
  } catch {
    return { ok: false, code: 'AUTH_INVITE_INVALID', message: 'payload not JSON' }
  }
  if (
    typeof claims.tenant_id !== 'string' ||
    typeof claims.role !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.jti !== 'string' ||
    !['owner', 'member', 'viewer'].includes(claims.role)
  ) {
    return {
      ok: false,
      code: 'AUTH_INVITE_INVALID',
      message: 'payload missing required claims',
    }
  }

  // Expiry
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (claims.exp <= now) {
    return { ok: false, code: 'AUTH_INVITE_EXPIRED', message: 'invite token has expired' }
  }

  return { ok: true, claims }
}

// ---------------------------------------------------------------------------
// Register handler
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPgUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === '23505'
}

/**
 * Validate the registration request, verify the invite, and create the
 * known_installs row.
 *
 * Idempotency caveat: if the same install_id retries with the same
 * (still-valid) invite token, we treat the second attempt as
 * AUTH_INVITE_ALREADY_USED (the unique constraint catches it). The operator's
 * CLI must persist install_id locally on first success and surface a clear
 * "already paired" error on subsequent runs — handled in cli/orbital-join.ts.
 */
export async function registerHandler(
  req: RegistrationRequest,
): Promise<RegistrationResult> {
  // 1. Validate request shape
  if (
    typeof req.install_id !== 'string' ||
    !UUID_RE.test(req.install_id) ||
    typeof req.public_key !== 'string' ||
    req.public_key.length === 0 ||
    typeof req.invite_token !== 'string' ||
    req.invite_token.length === 0
  ) {
    return {
      ok: false,
      code: 'AUTH_REQUEST_MALFORMED',
      message:
        'register: missing or malformed install_id / public_key / invite_token',
    }
  }

  // 2. Verify invite
  const inviteResult = verifyInvite(req.invite_token)
  if (!inviteResult.ok) {
    return { ok: false, code: inviteResult.code, message: inviteResult.message }
  }
  const { claims } = inviteResult

  // 3. Validate public_key decodes to 32 bytes (Ed25519)
  let pubBytes: Uint8Array
  try {
    pubBytes = base64UrlToBytes(req.public_key)
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_REQUEST_MALFORMED',
      message: `public_key is not valid base64url: ${(err as Error).message}`,
    }
  }
  if (pubBytes.length !== 32) {
    return {
      ok: false,
      code: 'AUTH_REQUEST_MALFORMED',
      message: `public_key must be 32 bytes (got ${pubBytes.length})`,
    }
  }

  // 4. Idempotency check: if this exact install_id already exists, return
  // AUTH_INVITE_ALREADY_USED (an operator running `orbital join` twice).
  // Otherwise, the unique-index on invite_jti will catch jti reuse.
  const existing = await getInstallById(req.install_id)
  if (existing) {
    return {
      ok: false,
      code: 'AUTH_INVITE_ALREADY_USED',
      message:
        'install_id already registered. To re-pair, ask an owner to revoke first.',
    }
  }

  // 5. Insert. Unique index on invite_jti enforces single-use globally.
  try {
    const identity = await registerInstall({
      installId: req.install_id,
      tenantId: claims.tenant_id,
      publicKey: req.public_key,
      role: claims.role,
      displayName: req.display_name ?? null,
      inviteJti: claims.jti,
    })

    logger.info(
      {
        installId: identity.installId,
        tenantId: identity.tenantId,
        role: identity.role,
        // NEVER log the full public key — first 12 chars is the fingerprint.
        fingerprint: identity.publicKey.slice(0, 12),
      },
      'hub-auth: install registered',
    )

    return {
      ok: true,
      install_id: identity.installId,
      tenant_id: identity.tenantId,
      role: identity.role,
      hub_pubkey: hubFingerprint(),
    }
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return {
        ok: false,
        code: 'AUTH_INVITE_ALREADY_USED',
        message: 'invite token has already been redeemed',
      }
    }
    logger.error({ err }, 'hub-auth: register insert failed')
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'register failed; check hub logs',
    }
  }
}
