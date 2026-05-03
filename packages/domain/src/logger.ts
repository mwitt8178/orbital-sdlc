/**
 * domain/src/logger.ts — Minimal structured logger for the domain package.
 *
 * Phase 3.4: the domain layer needs a logger that does not pull in the full
 * orchestrator config chain (env.ts → keytar → pino-pretty transport, etc.).
 * This module is intentionally lightweight — pino only, no pino-pretty dep,
 * no OTel span injection, no redact complexity.
 *
 * Files in this package that previously imported `../config/logger` (pointing
 * at the orchestrator's logger) now import from here.
 */

import pino from 'pino'
import type { Logger } from 'pino'

const isDev = process.env['NODE_ENV'] === 'development'

export const logger: Logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'orbital-domain' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'token',
      'api_key',
      'apiKey',
      'passphrase',
      '*.password',
      '*.token',
      '*.api_key',
      '*.apiKey',
      '*.passphrase',
      'capability_secret',
      'capabilitySecret',
      '*.capability_secret',
      '*.capabilitySecret',
      'signature',
      'private_key',
      'privateKey',
      '*.signature',
      '*.private_key',
      '*.privateKey',
    ],
    censor: '[REDACTED]',
  },
  transport:
    isDev
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
      : undefined,
})

export type { Logger }
