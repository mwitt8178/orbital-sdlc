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
export function canonicalJson(value: unknown): string {
  return serialize(value)
}

function serialize(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error('canonicalJson: non-finite number not allowed')
    }
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return '[' + v.map((item) => serialize(item)).join(',') + ']'
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + serialize((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    )
  }
  throw new Error(`canonicalJson: unsupported type ${typeof v}`)
}

/**
 * Encode UTF-8 bytes from a canonical JSON string. Used as the message bytes
 * for Ed25519 signing/verification.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}
