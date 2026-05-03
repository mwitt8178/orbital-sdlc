/**
 * hub-client/sanitize.ts — Runtime sanitiser middleware.
 *
 * Round 7-05 — Local-Only Concerns Isolation
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Walks an outgoing hub-request body and refuses requests that contain
 * patterns suggesting a local-only secret has been included. The sanitiser
 * runs at TWO points by design:
 *
 *   1. At the events boundary (`EventStore.append` mirrors event payloads to
 *      hub via Round 7-04 fanout) — sanitise before fanout.
 *   2. At the wire boundary (`HubClient.rpc()`) — sanitise EVERY outgoing
 *      tRPC call regardless of router. Defence in depth.
 *
 * On rejection: throws `LocalDataLeakError` (do NOT swallow), emits a CRITICAL
 * log with structured leak metadata, and increments a failure metric. The
 * caller must treat this as fatal for the request — the hub must not see a
 * single byte of the offending payload.
 *
 * Three layers of detection:
 *   - Field-name regex: any property named like a secret. Catches the
 *     "developer accidentally put `api_key` in payload" case.
 *   - Value pattern: known Anthropic key prefix (configured at startup) and
 *     the generic `sk-ant-` / `sk-` patterns.
 *   - Path heuristic: any string value pointing into local-only directories
 *     (`~/.orbital/keys/`, `~/.orbital/replays/`).
 *
 * False-positive surface area:
 *   - Field-name match is on the FIELD NAME, not the value. A memory entry
 *     with description "we use api_keys for auth" passes.
 *   - Value match looks for the literal substring `sk-ant-` followed by
 *     non-whitespace. A blog post about API keys would match — that's
 *     considered acceptable; users in those edge cases can either move the
 *     content out of payloads or expand the allow-list explicitly via env.
 *
 * No mocks: no third-party regex libs, no remote calls. Pure Node built-ins.
 */
/**
 * Configure the sanitiser with the install's actual Anthropic key prefix so
 * we can refuse leaks of THIS install's secret specifically (in addition to
 * the generic sk-ant- pattern). Call once at startup.
 *
 * Pass only the first ~14 chars (e.g. "sk-ant-api03-") — we never want the
 * full key in process memory beyond the env loader.
 */
export declare function setKnownAnthropicKeyPrefix(prefix: string): void;
/** Reset state. Used by tests only. */
export declare function resetSanitizerState(): void;
/**
 * Thrown when the sanitiser detects local-only data in a hub-bound payload.
 * The throw is fatal for the request — the hub must NOT see this payload.
 *
 * Properties are intentionally machine-readable so the alert path can record
 * structured leak metadata without re-parsing the message.
 */
export declare class LocalDataLeakError extends Error {
    readonly path: string;
    readonly reason: string;
    readonly procedure: string | null;
    constructor(path: string, reason: string, procedure?: string | null);
}
/**
 * Walk an arbitrary JSON-shaped value and throw `LocalDataLeakError` if any
 * sensitive pattern is detected. Returns void on success — the caller passes
 * the original (untouched) value to the hub.
 *
 * @param body      The payload to inspect. Can be any JSON-serialisable shape.
 * @param procedure Optional procedure name for richer error reporting.
 *
 * @throws LocalDataLeakError on detection.
 */
export declare function sanitizeForHub(body: unknown, procedure?: string | null): void;
//# sourceMappingURL=sanitize.d.ts.map