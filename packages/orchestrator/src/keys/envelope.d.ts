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
/**
 * The body that gets signed. Canonical JSON of this structure is the message
 * bytes for the Ed25519 signature.
 */
export interface EnvelopeBody {
    /** RPC method name, e.g. "tasks.list" or "audit.events.append". */
    method: string;
    /** sha256(request body bytes) hex-encoded; '' if no body. */
    params_hash: string;
    /** Wall-clock timestamp at sign time (ms since epoch). */
    ts: number;
    /** Random 16-byte nonce, base64url-encoded — replay-window unique. */
    nonce: string;
}
/**
 * Result of verifyEnvelope. Success carries the parsed body; failure
 * carries a stable error code that maps to AUTH_* on the wire.
 */
export type VerifyResult = {
    ok: true;
    body: EnvelopeBody;
} | {
    ok: false;
    code: AuthErrorCode;
    detail: string;
};
export type AuthErrorCode = 'AUTH_SIG_INVALID' | 'AUTH_TS_EXPIRED' | 'AUTH_REPLAY' | 'AUTH_BODY_MALFORMED' | 'AUTH_PARAMS_MISMATCH' | 'INSTALL_REVOKED' | 'INSTALL_UNKNOWN';
export declare function bytesToBase64Url(bytes: Uint8Array): string;
export declare function base64UrlToBytes(s: string): Uint8Array;
/**
 * Hex sha256 of the given bytes. Used for params_hash (request body fingerprint)
 * and exposed for tests + middleware that needs to compare client-asserted
 * hashes against the actual body.
 */
export declare function sha256Hex(bytes: Uint8Array): string;
/**
 * Generate a fresh 16-byte nonce as base64url. Used by the local signer to
 * tag every envelope with a unique value the hub can dedupe in its LRU.
 */
export declare function freshNonce(): string;
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
export declare function signEnvelope(opts: {
    method: string;
    bodyBytes: Uint8Array;
    privateKey: Uint8Array;
    /** Override Date.now() — tests only. */
    nowMs?: number;
    /** Override generated nonce — tests only. */
    nonce?: string;
}): Promise<{
    body: EnvelopeBody;
    bodyB64: string;
    signatureB64: string;
}>;
export interface VerifyOptions {
    /** Expected sender public key (base64url or raw bytes). */
    publicKey: Uint8Array;
    /** Header value of X-Orbital-Sig-Body (base64url envelope JSON). */
    bodyB64: string;
    /** Header value of X-Orbital-Sig (base64url Ed25519 signature). */
    signatureB64: string;
    /** Actual HTTP request body bytes (Uint8Array; empty buffer for no body). */
    requestBodyBytes: Uint8Array;
    /** Server clock (defaults to Date.now()). */
    nowMs?: number;
    /** Allowed clock skew, ms. Default ±60_000 (60 s). */
    maxDriftMs?: number;
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
export declare function verifyEnvelope(opts: VerifyOptions): Promise<VerifyResult>;
/**
 * NonceLru — bounded in-memory store of seen nonces with TTL.
 *
 * Sized to handle bursty traffic without unbounded memory growth: when full,
 * we evict the oldest entry. TTL defaults to 5 minutes (replay window).
 *
 * Per the architecture: a nonce that survives the TTL window will be caught
 * by the ts ±60s clock check anyway, so the LRU bound is sufficient.
 */
export declare class NonceLru {
    private readonly capacity;
    private readonly ttlMs;
    /** Map preserves insertion order — eldest first. */
    private readonly seen;
    constructor(opts?: {
        capacity?: number;
        ttlMs?: number;
    });
    /**
     * Try to record a nonce. Returns true if it was fresh (record succeeded);
     * false if it was a replay (already seen within TTL).
     */
    recordIfFresh(nonce: string, nowMs?: number): boolean;
    /** Test helper. */
    size(): number;
    /** Test helper. */
    clear(): void;
    private evictExpired;
}
export declare const HEADER_INSTALL_ID = "x-orbital-install-id";
export declare const HEADER_SIG = "x-orbital-sig";
export declare const HEADER_SIG_BODY = "x-orbital-sig-body";
//# sourceMappingURL=envelope.d.ts.map