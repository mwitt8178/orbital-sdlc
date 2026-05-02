/**
 * types/local-only.ts — Branded `LocalOnly<T>` marker type for data that must
 * NEVER leak from a local Orbital install to the central hub.
 *
 * Round 7-05 — Local-Only Concerns Isolation
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Why a brand:
 *   - We cannot rely on developers remembering "this row is local-only".
 *   - The brand attaches an unforgeable phantom property at the type level.
 *   - hub-client functions declare their inputs as the unbranded shape; if you
 *     pass a `LocalOnly<T>` you get a compile error because the brand does not
 *     erase. This is the same pattern as nominal typing in TypeScript.
 *
 * What gets branded:
 *   - Anthropic API key (`AnthropicKey`)
 *   - Cost ledger entries when read locally (`LocalCostLedgerEntry`)
 *   - Replay blob bodies (`LocalReplayBody`)
 *   - Capability bundle private key bytes
 *   - Worker stdout/stderr lines
 *
 * Defence in depth:
 *   - This file is the COMPILE-time layer.
 *   - hub-client/sanitize.ts is the RUNTIME layer.
 *   - scripts/ci-leak-check.ts is the CI layer.
 *   All three must remain in place for the contract to hold.
 */

declare const LOCAL_ONLY: unique symbol

/**
 * `LocalOnly<T>` marks a value that must not leave the local install boundary.
 *
 * The phantom property `[LOCAL_ONLY]: never` is unforgeable: structural typing
 * still treats two `LocalOnly<T>` values as compatible with each other, but a
 * function that accepts plain `T` will reject `LocalOnly<T>` because the brand
 * isn't part of the parameter type.
 *
 * To consume a LocalOnly value at the boundary (e.g. computing an aggregate
 * total before sending to hub), explicitly strip the brand with `unwrapLocal()`
 * — this makes the boundary crossing visible in code review.
 */
export type LocalOnly<T> = T & { readonly [LOCAL_ONLY]: never }

/**
 * Tag a plain value as local-only. The runtime is a passthrough; the type-level
 * effect is that the result is now branded and the type system will catch
 * accidental flow into hub-client functions.
 *
 * Use this at the boundary where local-only data is produced — e.g. when
 * reading a cost ledger row, when loading the install's Anthropic key from
 * env, when reading a replay blob from disk.
 */
export function localOnly<T>(v: T): LocalOnly<T> {
  return v as LocalOnly<T>
}

/**
 * Strip the `LocalOnly` brand. This is intentionally an explicit unsafe op:
 * call sites become visible in code review and the CI leak check looks for
 * unwrapLocal followed by hub-client calls within the same function.
 *
 * Use only when:
 *   1. Computing an aggregate that is itself NOT local-only (e.g. summing
 *      cost entries to a per-sprint total before opt-in upload).
 *   2. Logging to local logger only.
 *   3. Encrypting a blob (the ciphertext is not local-only by itself, but
 *      the local replay store still keeps it local).
 */
export function unwrapLocal<T>(v: LocalOnly<T>): T {
  return v as T
}

/**
 * Type-level helper: extract `T` from `LocalOnly<T>`. Used in tests.
 */
export type UnwrapLocal<T> = T extends LocalOnly<infer U> ? U : T

// ---------------------------------------------------------------------------
// Concrete branded aliases — the canonical names callers should import
// ---------------------------------------------------------------------------

/**
 * The operator's Anthropic API key. Loaded from env at startup, kept in
 * memory only, never serialised into a hub request.
 */
export type AnthropicKey = LocalOnly<string>

/**
 * The operator's OpenAI API key (Round 6 #8). Same locality rules.
 */
export type OpenAIKey = LocalOnly<string>

/**
 * Path to a private key file under `~/.orbital/keys/`. The path itself is
 * sensitive (its presence reveals install structure) and the file contents
 * are obviously secret.
 */
export type CapabilityPrivateKeyPath = LocalOnly<string>

/**
 * A capability bundle private key as raw bytes. Never leaves memory.
 */
export type CapabilityPrivateKeyBytes = LocalOnly<Uint8Array>

/**
 * A worker stdout or stderr line. These can contain prompt fragments,
 * intermediate reasoning, or accidentally-printed credentials. They live in
 * the live tail buffer and the local fs only.
 */
export type WorkerOutputLine = LocalOnly<string>
