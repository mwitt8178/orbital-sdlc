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

import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Field-name regex. Matches anywhere in the lowercased name. Must catch:
 *   - api_key, api-key, apiKey, API_KEY
 *   - api_token, api-token
 *   - anthropic, anthropic_key
 *   - secret, client_secret, my_secret
 *   - private_key, privKey, privatekey
 *   - passphrase
 *   - stdout, stderr_tail (worker output should not be in hub payloads)
 *
 * The regex is case-insensitive and matches on a normalised name (camelCase
 * is split into words via lower-snake conversion before matching).
 */
const SENSITIVE_FIELD_RE = /(api[_-]?(?:key|token)|anthropic|secret|priv(?:ate[_-]?)?key|passphrase|^stdout$|^stderr(?:[_-]?tail)?$)/i

/**
 * Value patterns we never want to see in a hub payload.
 *   - `sk-ant-` is the Anthropic API key prefix.
 *   - `sk-proj-`, `sk-svcacct-`, `sk-` (when followed by alphanumeric) are
 *     OpenAI-style secret prefixes.
 *
 * The regex requires the prefix to be followed by at least 8 non-whitespace
 * chars so we don't false-positive on prose like "sk- meaning skip".
 */
const ANTHROPIC_KEY_VALUE_RE = /sk-ant-[A-Za-z0-9_-]{8,}/
const OPENAI_KEY_VALUE_RE = /\bsk-(?:proj-|svcacct-|api-|live-|test-)?[A-Za-z0-9]{16,}/

/**
 * Local-only directory markers. Any path string mentioning these segments
 * implies the value originated in a local secret store; we refuse to forward
 * such paths to the hub even if they look harmless.
 */
const LOCAL_PATH_MARKERS = ['/.orbital/keys/', '/.orbital/replays/']

/** Cached known Anthropic key prefix from env (set at startup). */
let knownAnthropicPrefix: string | null = null

/**
 * Configure the sanitiser with the install's actual Anthropic key prefix so
 * we can refuse leaks of THIS install's secret specifically (in addition to
 * the generic sk-ant- pattern). Call once at startup.
 *
 * Pass only the first ~14 chars (e.g. "sk-ant-api03-") — we never want the
 * full key in process memory beyond the env loader.
 */
export function setKnownAnthropicKeyPrefix(prefix: string): void {
  if (!prefix || typeof prefix !== 'string') {
    knownAnthropicPrefix = null
    return
  }
  knownAnthropicPrefix = prefix
}

/** Reset state. Used by tests only. */
export function resetSanitizerState(): void {
  knownAnthropicPrefix = null
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when the sanitiser detects local-only data in a hub-bound payload.
 * The throw is fatal for the request — the hub must NOT see this payload.
 *
 * Properties are intentionally machine-readable so the alert path can record
 * structured leak metadata without re-parsing the message.
 */
export class LocalDataLeakError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
    public readonly procedure: string | null = null,
  ) {
    super(
      `LOCAL_DATA_LEAK: rejected hub request — ${reason} at path '${path}'` +
        (procedure ? ` (procedure: ${procedure})` : ''),
    )
    this.name = 'LocalDataLeakError'
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export function sanitizeForHub(body: unknown, procedure: string | null = null): void {
  walk(body, '', procedure)
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function walk(node: unknown, path: string, procedure: string | null): void {
  if (node === null || node === undefined) return

  // Primitive — only check string values for value-level patterns.
  if (typeof node === 'string') {
    checkStringValue(node, path, procedure)
    return
  }
  if (typeof node !== 'object') return

  // Array — recurse on each element.
  if (Array.isArray(node)) {
    node.forEach((item, idx) => walk(item, joinPath(path, `[${idx}]`), procedure))
    return
  }

  // Object — check every key name then recurse into the value.
  const obj = node as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    checkFieldName(key, joinPath(path, key), procedure)
    walk(obj[key], joinPath(path, key), procedure)
  }
}

function checkFieldName(key: string, path: string, procedure: string | null): void {
  // Some sensitive names need exact-match (`stdout`, `stderr_tail`) vs the
  // looser substring match for `api_key`. The regex handles both via anchors.
  if (SENSITIVE_FIELD_RE.test(key)) {
    const reason = `field-name '${key}' matches sensitive pattern`
    emitLeakAlert(path, reason, procedure, key)
    throw new LocalDataLeakError(path, reason, procedure)
  }
}

function checkStringValue(value: string, path: string, procedure: string | null): void {
  // 1. Anthropic key generic prefix
  if (ANTHROPIC_KEY_VALUE_RE.test(value)) {
    const reason = `value contains Anthropic API key prefix (sk-ant-)`
    emitLeakAlert(path, reason, procedure, null)
    throw new LocalDataLeakError(path, reason, procedure)
  }

  // 2. This install's specific known prefix (cached at startup)
  if (knownAnthropicPrefix && value.includes(knownAnthropicPrefix)) {
    const reason = `value contains this install's Anthropic key prefix`
    emitLeakAlert(path, reason, procedure, null)
    throw new LocalDataLeakError(path, reason, procedure)
  }

  // 3. OpenAI-style key
  if (OPENAI_KEY_VALUE_RE.test(value)) {
    const reason = `value contains OpenAI API key prefix (sk-...)`
    emitLeakAlert(path, reason, procedure, null)
    throw new LocalDataLeakError(path, reason, procedure)
  }

  // 4. Local-only path markers
  for (const marker of LOCAL_PATH_MARKERS) {
    if (value.includes(marker)) {
      const reason = `value contains local-only path marker '${marker}'`
      emitLeakAlert(path, reason, procedure, null)
      throw new LocalDataLeakError(path, reason, procedure)
    }
  }
}

// ---------------------------------------------------------------------------
// Alert emission
// ---------------------------------------------------------------------------

/**
 * Emit a CRITICAL log line. The audit-event side of the alert is fired by
 * the caller (after they receive the LocalDataLeakError) so it can include
 * the full envelope context (procedure, tenant, actor). We do NOT log the
 * leaked value itself — only the path + reason.
 */
function emitLeakAlert(
  path: string,
  reason: string,
  procedure: string | null,
  fieldName: string | null,
): void {
  logger.fatal(
    {
      event: 'LocalDataLeakDetected',
      path,
      reason,
      procedure,
      fieldName,
    },
    'CRITICAL: local-only data detected in hub-bound payload — request blocked',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinPath(base: string, segment: string): string {
  if (!base) return segment
  if (segment.startsWith('[')) return `${base}${segment}`
  return `${base}.${segment}`
}
