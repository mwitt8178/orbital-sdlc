/**
 * keys/envelope.ts — Signed-envelope primitives for federation auth.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Every local-to-hub request carries a signed envelope so the hub can identify
 * the install and reject tampered or replayed requests. The envelope is
 * Ed25519-signed over canonical JSON of `{method, params_hash, ts, nonce}`.
 *
 * Wire format (HTTP headers on every request):
 *   X-Orbital-Install-Id:  <uuid>
 *   X-Orbital-Sig-Body:    <base64url canonical JSON of the envelope>
 *   X-Orbital-Sig:         <base64url Ed25519 signature over the body bytes>
 *
 * Hub validates:
 *   1. Decode Sig-Body, parse JSON.
 *   2. ts within ±60s of server time (clock-drift tolerance).
 *   3. nonce not seen in last 5 min (replay window) — in-memory LRU.
 *   4. params_hash matches sha256(actual request body bytes).
 *   5. Ed25519 sig verifies against known_installs[install_id].public_key.
 *   6. revoked_at IS NULL.
 *
 * Real cryptography only — `@noble/ed25519` v2 with SHA-512 wired in. No
 * hand-rolled crypto. base64url (RFC 4648 §5) avoids URL-encoding issues
 * across HTTP intermediaries.
 *
 * Reuses the canonical-json serializer from capabilities/canonical-json.ts so
 * envelope canonicalization matches every other place we sign JSON in Orbital.
 */

import * as ed from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { sha512 } from '@noble/hashes/sha512'
import { canonicalBytes } from '../capabilities/canonical-json.js'

// Wire SHA-512 once at module load. @noble/ed25519 v2 requires this before
// any sign/verify call. Idempotent if already wired by capabilities/keys.ts.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
}
if (!ed.etc.sha512Async) {
  ed.etc.sha512Async = async (...messages: Uint8Array[]) =>
    sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The body that gets signed. Canonical JSON of this structure is the message
 * bytes for the Ed25519 signature.
 */
export interface EnvelopeBody {
  /** RPC method name, e.g. "tasks.list" or "audit.events.append". */
  method: string
  /** sha256(request body bytes) hex-encoded; '' if no body. */
  params_hash: string
  /** Wall-clock timestamp at sign time (ms since epoch). */
  ts: number
  /** Random 16-byte nonce, base64url-encoded — replay-window unique. */
  nonce: string
}

/**
 * Result of verifyEnvelope. Success carries the parsed body; failure
 * carries a stable error code that maps to AUTH_* on the wire.
 */
export type VerifyResult =
  | { ok: true; body: EnvelopeBody }
  | { ok: false; code: AuthErrorCode; detail: string }

export type AuthErrorCode =
  | 'AUTH_SIG_INVALID'
  | 'AUTH_TS_EXPIRED'
  | 'AUTH_REPLAY'
  | 'AUTH_BODY_MALFORMED'
  | 'AUTH_PARAMS_MISMATCH'
  | 'INSTALL_REVOKED'
  | 'INSTALL_UNKNOWN'

// ---------------------------------------------------------------------------
// base64url helpers — RFC 4648 §5 (URL-safe, no padding)
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/')
  const padLen = (4 - (padded.length % 4)) % 4
  return new Uint8Array(Buffer.from(padded + '='.repeat(padLen), 'base64'))
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hex sha256 of the given bytes. Used for params_hash (request body fingerprint)
 * and exposed for tests + middleware that needs to compare client-asserted
 * hashes against the actual body.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}

/**
 * Generate a fresh 16-byte nonce as base64url. Used by the local signer to
 * tag every envelope with a unique value the hub can dedupe in its LRU.
 */
export function freshNonce(): string {
  const buf = new Uint8Array(16)
  // crypto.getRandomValues is available in Node 18+ via globalThis.crypto
  globalThis.crypto.getRandomValues(buf)
  return bytesToBase64Url(buf)
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Build an envelope body for the given method + body bytes, sign it with the
 * private key, and return the wire headers ready to attach to a request.
 *
 * Caller passes the request body bytes (or empty Uint8Array for no body) so
 * we can compute params_hash without round-tripping through JSON ourselves.
 *
 * The `ts` field defaults to Date.now() but can be overridden for tests
 * (e.g. clock-drift checks).
 */
export async function signEnvelope(opts: {
  method: string
  bodyBytes: Uint8Array
  privateKey: Uint8Array
  /** Override Date.now() — tests only. */
  nowMs?: number
  /** Override generated nonce — tests only. */
  nonce?: string
}): Promise<{
  body: EnvelopeBody
  bodyB64: string
  signatureB64: string
}> {
  const ts = opts.nowMs ?? Date.now()
  const nonce = opts.nonce ?? freshNonce()
  const body: EnvelopeBody = {
    method: opts.method,
    params_hash: sha256Hex(opts.bodyBytes),
    ts,
    nonce,
  }

  const bodyBytes = canonicalBytes(body)
  const sig = await ed.signAsync(bodyBytes, opts.privateKey)

  return {
    body,
    bodyB64: bytesToBase64Url(bodyBytes),
    signatureB64: bytesToBase64Url(sig),
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  /** Expected sender public key (base64url or raw bytes). */
  publicKey: Uint8Array
  /** Header value of X-Orbital-Sig-Body (base64url envelope JSON). */
  bodyB64: string
  /** Header value of X-Orbital-Sig (base64url Ed25519 signature). */
  signatureB64: string
  /** Actual HTTP request body bytes (Uint8Array; empty buffer for no body). */
  requestBodyBytes: Uint8Array
  /** Server clock (defaults to Date.now()). */
  nowMs?: number
  /** Allowed clock skew, ms. Default ±60_000 (60 s). */
  maxDriftMs?: number
}

/**
 * Verify an envelope. Returns a discriminated union — never throws on
 * normal "auth failed" outcomes. Throws only on programmer errors
 * (e.g. malformed Uint8Array inputs).
 *
 * Replay protection (nonce LRU) is NOT done here; that's the caller's
 * responsibility because it requires the in-memory store. We expose the
 * decoded `body.nonce` so the caller can dedupe.
 */
export async function verifyEnvelope(opts: VerifyOptions): Promise<VerifyResult> {
  const now = opts.nowMs ?? Date.now()
  const maxDrift = opts.maxDriftMs ?? 60_000

  // 1. Decode body
  let bodyBytes: Uint8Array
  try {
    bodyBytes = base64UrlToBytes(opts.bodyB64)
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_BODY_MALFORMED',
      detail: `body decode failed: ${(err as Error).message}`,
    }
  }

  let body: EnvelopeBody
  try {
    const parsed = JSON.parse(Buffer.from(bodyBytes).toString('utf-8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.method !== 'string' ||
      typeof parsed.params_hash !== 'string' ||
      typeof parsed.ts !== 'number' ||
      typeof parsed.nonce !== 'string'
    ) {
      return {
        ok: false,
        code: 'AUTH_BODY_MALFORMED',
        detail: 'envelope body missing required fields',
      }
    }
    body = parsed as EnvelopeBody
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_BODY_MALFORMED',
      detail: `body JSON parse failed: ${(err as Error).message}`,
    }
  }

  // 2. ts within ±maxDriftMs
  const drift = Math.abs(now - body.ts)
  if (drift > maxDrift) {
    return {
      ok: false,
      code: 'AUTH_TS_EXPIRED',
      detail: `clock drift ${drift}ms exceeds max ${maxDrift}ms`,
    }
  }

  // 3. params_hash matches actual body bytes
  const actualHash = sha256Hex(opts.requestBodyBytes)
  if (actualHash !== body.params_hash) {
    return {
      ok: false,
      code: 'AUTH_PARAMS_MISMATCH',
      detail: `body sha256 mismatch (asserted ${body.params_hash.slice(0, 8)}…, actual ${actualHash.slice(0, 8)}…)`,
    }
  }

  // 4. Verify signature over the canonical body bytes (NOT the b64 string).
  let sig: Uint8Array
  try {
    sig = base64UrlToBytes(opts.signatureB64)
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_SIG_INVALID',
      detail: `sig decode failed: ${(err as Error).message}`,
    }
  }

  // Re-canonicalize the body to defeat clients that re-order keys in their
  // bodyB64. The signer signs canonical bytes; the verifier must check
  // canonical bytes too. If a client sent non-canonical bytes, both `sign`
  // and `verify` are computed over canonical bytes derived from the parsed
  // body, so the b64 over the wire is informational only — the trust anchor
  // is the canonical re-serialisation.
  const canonical = canonicalBytes(body)

  let ok = false
  try {
    ok = await ed.verifyAsync(sig, canonical, opts.publicKey)
  } catch (err) {
    return {
      ok: false,
      code: 'AUTH_SIG_INVALID',
      detail: `verify threw: ${(err as Error).message}`,
    }
  }

  if (!ok) {
    return { ok: false, code: 'AUTH_SIG_INVALID', detail: 'Ed25519 verification failed' }
  }

  return { ok: true, body }
}

// ---------------------------------------------------------------------------
// Nonce LRU — replay protection
// ---------------------------------------------------------------------------

/**
 * NonceLru — bounded in-memory store of seen nonces with TTL.
 *
 * Sized to handle bursty traffic without unbounded memory growth: when full,
 * we evict the oldest entry. TTL defaults to 5 minutes (replay window).
 *
 * Per the architecture: a nonce that survives the TTL window will be caught
 * by the ts ±60s clock check anyway, so the LRU bound is sufficient.
 */
export class NonceLru {
  private readonly capacity: number
  private readonly ttlMs: number
  /** Map preserves insertion order — eldest first. */
  private readonly seen = new Map<string, number>()

  constructor(opts: { capacity?: number; ttlMs?: number } = {}) {
    this.capacity = opts.capacity ?? 10_000
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000
  }

  /**
   * Try to record a nonce. Returns true if it was fresh (record succeeded);
   * false if it was a replay (already seen within TTL).
   */
  recordIfFresh(nonce: string, nowMs: number = Date.now()): boolean {
    // Lazy-evict expired
    this.evictExpired(nowMs)

    const existing = this.seen.get(nonce)
    if (existing !== undefined && nowMs - existing < this.ttlMs) {
      return false
    }

    this.seen.set(nonce, nowMs)

    // Bound capacity — drop the oldest
    while (this.seen.size > this.capacity) {
      const first = this.seen.keys().next()
      if (first.done) break
      this.seen.delete(first.value as string)
    }
    return true
  }

  /** Test helper. */
  size(): number {
    return this.seen.size
  }

  /** Test helper. */
  clear(): void {
    this.seen.clear()
  }

  private evictExpired(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs
    // Iterate insertion-ordered; bail at first non-expired entry
    for (const [nonce, ts] of this.seen) {
      if (ts <= cutoff) {
        this.seen.delete(nonce)
      } else {
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

export const HEADER_INSTALL_ID = 'x-orbital-install-id'
export const HEADER_SIG = 'x-orbital-sig'
export const HEADER_SIG_BODY = 'x-orbital-sig-body'
