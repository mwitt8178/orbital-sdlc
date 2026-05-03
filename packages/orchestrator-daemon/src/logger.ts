/**
 * Structured logger for the orchestrator daemon.
 *
 * Phase 5.1 of the migration: enforces tenant_id on every log line. Boot
 * lines use `tenant_id: 'system'`. Per-request lines must pass an explicit
 * tenant_id (typed via TenantContext).
 *
 * Redaction list covers the standard secret-shaped fields. Production
 * mode emits raw JSON; dev (NODE_ENV=development) uses pino-pretty for
 * humans (pino-pretty must be installed in the daemon's runtime image —
 * it is, since the daemon is not a Lambda).
 */

import pino, { type Logger } from 'pino'
import { ulid } from 'ulid'
import { hostname } from 'node:os'

const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'authorization',
  'apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.authorization',
  '*.apiKey',
  'creds',
  'creds.*',
  'jwt',
  'cookie',
  'set-cookie',
  '*.cookie',
] as const

/**
 * Tenant context — must be present on every per-request log line. Boot
 * lines and timer lines use 'system'.
 */
export interface TenantContext {
  readonly tenant_id: string
}

const isDev = process.env['NODE_ENV'] === 'development'

const baseLogger: Logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: 'orchestrator-daemon',
    env: process.env['ORBITAL_ENV'] ?? 'unknown',
    instance: process.env['HOSTNAME'] ?? hostname(),
    boot_id: ulid(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  // CloudWatch ingestion expects raw JSON; pino-pretty only in dev.
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
})

/**
 * System logger — for boot, shutdown, scheduler ticks, etc. Always sets
 * tenant_id='system'.
 */
export const systemLogger: Logger = baseLogger.child({ tenant_id: 'system' })

/**
 * Per-tenant logger — call this with a TenantContext to enforce tenant_id
 * at the type level. Logs from this child carry tenant_id automatically.
 */
export function loggerForTenant(ctx: TenantContext): Logger {
  return baseLogger.child({ tenant_id: ctx.tenant_id })
}

/**
 * Test-only — re-export the base for explicit shaping. Not for production
 * use because it has no tenant_id; leaks would fail the tenant-bleed lint.
 */
export const _baseLoggerForTests: Logger = baseLogger
