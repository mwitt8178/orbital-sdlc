/**
 * Canonical JSON serialization for capability bundles.
 *
 * Per TRD-06 §4.2: the signature covers JCS-style canonical JSON of the
 * bundle with the `signature` field removed.
 *
 * JCS (RFC 8785) canonicalization: sorted keys (UCS code-point order),
 * no insignificant whitespace, no escape variants.
 *
 * This is a small, vetted implementation. We do not depend on a third-party
 * canonicalizer because the bundle's value space is well-known: JSON-safe
 * primitives, arrays, objects, and the ed25519 signature is base64. No
 * NaN/Infinity, no large integers above Number.MAX_SAFE_INTEGER, no Unicode
 * surrogate edge cases beyond what JSON.stringify already handles.
 */
/**
 * Serialize a value to canonical JSON.
 * - Object keys are sorted lexicographically by UTF-16 code-unit value
 *   (matches JS String comparison and JCS).
 * - Arrays preserve order.
 * - Primitives use JSON.stringify (which handles UTF-8 escaping).
 * - undefined fields are omitted (consistent with JSON.stringify behavior).
 */
export declare function canonicalJson(value: unknown): string;
/**
 * Encode UTF-8 bytes from a canonical JSON string. Used as the message bytes
 * for Ed25519 signing/verification.
 */
export declare function canonicalBytes(value: unknown): Uint8Array;
//# sourceMappingURL=canonical-json.d.ts.map