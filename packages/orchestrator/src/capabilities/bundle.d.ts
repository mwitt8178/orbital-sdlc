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
import { type CapabilityBundle, type CapabilityBundleUnsigned } from '@orbital/types';
import type { KeyManager } from './keys.js';
/**
 * Default clock-skew tolerance (30 seconds) per TRD-06 §6.3 and industry norm.
 * Applied symmetrically: issued_at may be up to this far in the future,
 * and expires_at is extended by this amount before checking expiry.
 */
export declare const CLOCK_SKEW_TOLERANCE_MS = 30000;
export interface VerifyResult {
    ok: boolean;
    reasonCode?: string;
    reasonDetail?: string;
}
export interface VerifyBundleOptions {
    /**
     * Clock-skew tolerance in milliseconds. Defaults to CLOCK_SKEW_TOLERANCE_MS (30s).
     * Set to 0 to disable tolerance entirely (strict mode).
     */
    clockSkewMs?: number;
}
/**
 * Sign an unsigned capability bundle. Returns the bundle with the `signature`
 * field set. Caller is responsible for shape-validating the unsigned bundle
 * via CapabilityBundleUnsignedSchema before invoking this.
 */
export declare function signBundle(unsigned: CapabilityBundleUnsigned, keyManager: KeyManager): Promise<CapabilityBundle>;
/** SHA-256 hash of the canonical bundle without signature, hex-encoded. */
export declare function bundleHash(unsigned: CapabilityBundleUnsigned): string;
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
export declare function verifyBundle(bundle: unknown, keyManager: KeyManager, now?: Date, opts?: VerifyBundleOptions): Promise<VerifyResult>;
/** Direct DB check: any revocation row for this capability. */
export declare function isRevoked(capabilityId: string): Promise<boolean>;
/**
 * Pure-function variant of verify (no DB access). Used by callers that already
 * loaded the public key + revocation list elsewhere — e.g. the future MCP
 * gateway with in-memory caches.
 */
export declare function verifyBundleSignatureOnly(bundle: unknown, publicKey: Uint8Array): Promise<VerifyResult>;
//# sourceMappingURL=bundle.d.ts.map