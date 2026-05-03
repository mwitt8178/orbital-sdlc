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
import { HEADER_INSTALL_ID, HEADER_SIG, HEADER_SIG_BODY } from '../keys/envelope.js';
/**
 * Set a custom key path for tests. Resets the cache.
 */
export declare function _setInstallKeyPath(filePath: string | undefined): void;
/**
 * Reset the cached install key — tests only.
 */
export declare function _resetCachedInstallKey(): void;
export interface SignedHeaders {
    [HEADER_INSTALL_ID]: string;
    [HEADER_SIG]: string;
    [HEADER_SIG_BODY]: string;
}
/**
 * Build the X-Orbital-* headers for a request to the hub.
 *
 * @param method  RPC method or HTTP path being signed (e.g. "tasks.list")
 * @param bodyBytes  Raw request body bytes (Uint8Array). Empty buffer for no body.
 */
export declare function buildSignedHeaders(method: string, bodyBytes: Uint8Array): Promise<SignedHeaders>;
/**
 * attachAuthHeaders — convenience that mutates a headers record in-place.
 * Used by the existing hub-client.ts which builds a `headers` object before
 * calling fetch().
 */
export declare function attachAuthHeaders(headers: Record<string, string>, method: string, bodyBytes: Uint8Array): Promise<void>;
/**
 * Get the install_id of the current local install. Useful for telemetry / UX.
 */
export declare function getLocalInstallId(): Promise<string>;
/**
 * Get the public key of the current local install (base64url). Useful for the
 * `orbital join` CLI which needs to send this to the hub.
 */
export declare function getLocalPublicKeyB64(): Promise<string>;
//# sourceMappingURL=auth.d.ts.map