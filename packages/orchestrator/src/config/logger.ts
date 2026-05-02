import pino from 'pino'
import { trace } from '@opentelemetry/api'
import { loadEnv } from './env.js'

const e = loadEnv()

export const logger = pino({
  level: e.LOG_LEVEL,
  base: { service: 'orbital-orchestrator' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // ---------------------------------------------------------------------------
  // Round 3 S6 — expanded redact paths.
  //
  // Pino redact paths support globs. `*.password` matches the property at any
  // depth. We list both glob and exact paths because pino's globbing is
  // limited (does not match across array index boundaries).
  //
  // Categories covered:
  //   - Auth:        password / token / api key / passphrase / authorization
  //   - Capabilities: capability_secret + capability_id (re-correlation risk)
  //   - Cryptographic: signatures, private keys, master keys
  //   - WS / session: ws_token, session_token, x-orbital-* request headers
  //   - Cookies:     set-cookie, authorization
  //   - Scope/secret references:  scopes.secrets.* (the secret names)
  //
  // If a new sensitive field is introduced anywhere in the codebase, add it
  // here and a unit test in test/unit/config/logger-redact.test.ts.
  // ---------------------------------------------------------------------------
  redact: {
    paths: [
      // Auth credentials — both top-level and one-level-nested coverage.
      // pino's `*.foo` only matches `<anything>.foo` (depth 1+), NOT a
      // root-level `foo`. So we list both root and `*.foo` forms.
      'password',
      'passwordHash',
      'token',
      'api_key',
      'apiKey',
      'passphrase',
      'passphrases',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.api_key',
      '*.apiKey',
      '*.passphrase',
      '*.passphrases',
      'payload.passphrase',
      'payload.api_key',

      // Capability identity / secrets
      'capability_secret',
      'capabilitySecret',
      'capability_id',
      'capabilityId',
      '*.capability_secret',
      '*.capabilitySecret',
      '*.capability_id',
      '*.capabilityId',

      // Scope.secrets.* — the secret *names* themselves are sensitive
      '*.scopes.secrets',
      'scopes.secrets',

      // Crypto keys / signatures
      'signature',
      'private_key',
      'privateKey',
      'master_key',
      'masterKey',
      '*.bundle.signature',
      '*.signature',
      '*.private_key',
      '*.privateKey',
      '*.master_key',
      '*.masterKey',
      'bundle.signature',

      // Session / WS
      'ws_token',
      'wsToken',
      'session_token',
      'sessionToken',
      '*.ws_token',
      '*.wsToken',
      '*.session_token',
      '*.sessionToken',

      // x-orbital-* request headers carrying tokens
      '*.x-orbital-ws-token',
      '*.x-orbital-admin-token',
      '*.x-orbital-capability',
      'req.headers.x-orbital-ws-token',
      'req.headers.x-orbital-admin-token',
      'req.headers.x-orbital-capability',

      // Standard auth headers
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  transport:
    e.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
      : undefined,
})

export type Logger = typeof logger

// ---------------------------------------------------------------------------
// loggerWithContext — additive child-logger helper (Phase 6B)
//
// Returns a child logger that automatically injects the active OTel trace_id,
// plus any caller-supplied context fields (actor.type, capability_id, etc.).
//
// The global `logger` is unchanged; callers opt-in by using this helper.
// ---------------------------------------------------------------------------

export interface LogContext {
  actor_type?: string
  capability_id?: string
  [key: string]: unknown
}

const NOOP_TRACE_ID = '00000000000000000000000000000000'

export function loggerWithContext(ctx: LogContext = {}): pino.Logger {
  const activeSpan = trace.getActiveSpan()
  const spanTraceId = activeSpan?.spanContext().traceId

  const traceId =
    spanTraceId && spanTraceId !== NOOP_TRACE_ID ? spanTraceId : undefined

  return logger.child({
    ...(traceId ? { trace_id: traceId } : {}),
    ...ctx,
  })
}
