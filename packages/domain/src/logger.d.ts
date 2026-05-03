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
import type { Logger } from 'pino';
export declare const logger: Logger;
export type { Logger };
//# sourceMappingURL=logger.d.ts.map