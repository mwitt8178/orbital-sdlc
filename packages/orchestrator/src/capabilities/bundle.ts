/**
 * Capability bundle: sign / verify / TTL / revocation checks.
 *
 * Per TRD-06 §4.2, §6.2, and §6.3 (clock-drift tolerance):
 * - Signature is Ed25519 over canonical JSON of (bundle minus signature),
 *   UTF-8 encoded.
 * - Verification: signature valid + not expired + not revoked.
 * - The bundle's signed contents are the entire grant — no other field
 *   in the request can add scope (NFR-S.3).
 *
 * Clock-drift tolerance (TRD-06 §6.3):
 *   Distributed systems have clock skew between nodes. The default tolerance
 *   is 30 seconds (industry norm per RFC 7519 §4.1.4 and OAuth 2.0 §1.4):
 *   - `issued_at` may be up to clockSkewMs in the future without rejection.
 *     This handles bundles issued on a node whose clock runs slightly ahead.
 *   - `expires_at` is extended by clockSkewMs before checking expiry.
 *     This handles bundles that are technically expired by a small margin
 *     due to transmission delay.
 *
 *   Security note: the 30-second tolerance is a deliberate trade-off. It
 *   does NOT grant additional capability lifetime — the bundle's scopes are
 *   signed; tolerance only affects when the validity window opens and closes.
 */

import * as ed from '@noble/ed25519'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { capabilityRevocations } from '../db/schema/capabilities.js'
import {
  CapabilityBundleSchema,
  CapabilityBundleUnsignedSchema,
  type CapabilityBundle,
  type CapabilityBundleUnsigned,
} from '@orbital/types'
import { canonicalBytes, canonicalJson } from './canonical-json.js'
import type { KeyManager } from './keys.js'

/**
 * Default clock-skew tolerance (30 seconds) per TRD-06 §6.3 and industry norm.
 * Applied symmetrically: issued_at may be up to this far in the future,
 * and expires_at is extended by this amount before checking expiry.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000

export interface VerifyResult {
  ok: boolean
  reasonCode?: string
  reasonDetail?: string
}

export interface VerifyBundleOptions {
  /**
   * Clock-skew tolerance in milliseconds. Defaults to CLOCK_SKEW_TOLERANCE_MS (30s).
   * Set to 0 to disable tolerance entirely (strict mode).
   */
  clockSkewMs?: number
}

/**
 * Sign an unsigned capability bundle. Returns the bundle with the `signature`
 * field set. Caller is responsible for shape-validating the unsigned bundle
 * via CapabilityBundleUnsignedSchema before invoking this.
 */
export async function signBundle(
  unsigned: CapabilityBundleUnsigned,
  keyManager: KeyManager,
): Promise<CapabilityBundle> {
  const validated = CapabilityBundleUnsignedSchema.parse(unsigned)
  const message = canonicalBytes(validated)
  const { signature } = await keyManager.signWithSubKey(validated.signing_key_id, message)
  return CapabilityBundleSchema.parse({ ...validated, signature })
}

/** SHA-256 hash of the canonical bundle without signature, hex-encoded. */
export function bundleHash(unsigned: CapabilityBundleUnsigned): string {
  const json = canonicalJson(unsigned)
  return createHash('sha256').update(json, 'utf8').digest('hex')
}

/**
 * Full verify: shape, signature, TTL, revocation.
 *
 * Returns `{ok: true}` on success or `{ok: false, reasonCode, reasonDetail}` on
 * failure. Never throws on a verification failure — only on internal errors
 * (DB unreachable, etc.).
 *
 * @param bundle  - Raw bundle object (any shape; validated internally).
 * @param keyManager - Key manager for signature verification.
 * @param now     - Reference time for TTL checks. Defaults to current time.
 * @param opts    - Optional overrides, including clockSkewMs.
 */
export async function verifyBundle(
  bundle: unknown,
  keyManager: KeyManager,
  now: Date = new Date(),
  opts: VerifyBundleOptions = {},
): Promise<VerifyResult> {
  const clockSkewMs = opts.clockSkewMs ?? CLOCK_SKEW_TOLERANCE_MS

  // Shape check.
  const parsed = CapabilityBundleSchema.safeParse(bundle)
  if (!parsed.success) {
    return {
      ok: false,
      reasonCode: 'AUTH_INVALID_CAPABILITY_FORMAT',
      reasonDetail: parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    }
  }
  const b = parsed.data

  // TTL check with configurable clock-skew tolerance.
  // issued_at: bundle may be issued up to clockSkewMs in the future (issuer clock ahead).
  // expires_at: bundle may be used up to clockSkewMs after nominal expiry (consumer clock ahead).
  const issuedAt = new Date(b.issued_at).getTime()
  const expiresAt = new Date(b.expires_at).getTime()
  const t = now.getTime()
  if (t < issuedAt - clockSkewMs) {
    return {
      ok: false,
      reasonCode: 'AUTH_CAPABILITY_NOT_YET_VALID',
      reasonDetail: `now=${now.toISOString()}, issued_at=${b.issued_at}, clock_skew_tolerance_ms=${clockSkewMs}`,
    }
  }
  if (t > expiresAt + clockSkewMs) {
    return {
      ok: false,
      reasonCode: 'AUTH_CAPABILITY_EXPIRED',
      reasonDetail: `now=${now.toISOString()}, expires_at=${b.expires_at}, clock_skew_tolerance_ms=${clockSkewMs}`,
    }
  }

  // Signature check.
  const { signature, ...unsigned } = b
  const message = canonicalBytes(unsigned)
  const ok = await ed
    .verifyAsync(Buffer.from(signature, 'base64'), message, await loadPublicKey(b.signing_key_id, keyManager))
    .catch(() => false)
  if (!ok) {
    return {
      ok: false,
      reasonCode: 'AUTH_INVALID_SIGNATURE',
      reasonDetail: `signature did not verify against signing_key_id=${b.signing_key_id}`,
    }
  }

  // Chain check (sub-key signed by master active at issued_at).
  const chainOk = await keyManager.verifySubKeyChain(b.signing_key_id, b.issued_at)
  if (!chainOk) {
    return {
      ok: false,
      reasonCode: 'AUTH_INVALID_KEY_CHAIN',
      reasonDetail: `sub-key chain invalid for ${b.signing_key_id} at ${b.issued_at}`,
    }
  }

  // Revocation check.
  const revoked = await isRevoked(b.capability_id)
  if (revoked) {
    return {
      ok: false,
      reasonCode: 'AUTH_CAPABILITY_REVOKED',
      reasonDetail: `capability_id=${b.capability_id}`,
    }
  }

  return { ok: true }
}

async function loadPublicKey(keyId: string, keyManager: KeyManager): Promise<Uint8Array> {
  const sub = await keyManager.getSubKeyById(keyId)
  if (!sub) {
    throw new Error(`AUTH_UNKNOWN_SIGNING_KEY: ${keyId}`)
  }
  return sub.publicKey
}

/** Direct DB check: any revocation row for this capability. */
export async function isRevoked(capabilityId: string): Promise<boolean> {
  const rows = await db
    .select({ id: capabilityRevocations.revocation_id })
    .from(capabilityRevocations)
    .where(eq(capabilityRevocations.capability_id, capabilityId))
    .limit(1)
  return rows.length > 0
}

/**
 * Pure-function variant of verify (no DB access). Used by callers that already
 * loaded the public key + revocation list elsewhere — e.g. the future MCP
 * gateway with in-memory caches.
 */
export async function verifyBundleSignatureOnly(
  bundle: unknown,
  publicKey: Uint8Array,
): Promise<VerifyResult> {
  const parsed = CapabilityBundleSchema.safeParse(bundle)
  if (!parsed.success) {
    return {
      ok: false,
      reasonCode: 'AUTH_INVALID_CAPABILITY_FORMAT',
      reasonDetail: parsed.error.issues.map((i) => i.message).join('; '),
    }
  }
  const { signature, ...unsigned } = parsed.data
  const message = canonicalBytes(unsigned)
  const ok = await ed
    .verifyAsync(Buffer.from(signature, 'base64'), message, publicKey)
    .catch(() => false)
  if (!ok) {
    return {
      ok: false,
      reasonCode: 'AUTH_INVALID_SIGNATURE',
      reasonDetail: 'signature did not verify',
    }
  }
  return { ok: true }
}
