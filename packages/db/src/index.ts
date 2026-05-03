/**
 * @orbital/db — Aurora client + Drizzle schema barrel.
 *
 * Phase 3.2 of the migration plan: this package extracts what currently
 * lives at packages/orchestrator/src/db/. Until the migration completes,
 * this barrel re-exports from the orchestrator package so consumers can
 * already import from `@orbital/db` while the file moves are scheduled.
 *
 * Phase 3.6 will enforce that no consumer imports DB code from the legacy
 * orchestrator path; this barrel becomes the only entry.
 */

// Re-exports during migration; replace with native imports after the file moves.
export { getDb, closeDb, sql, db } from '../../orchestrator/src/db/client.js'
export type { DB } from '../../orchestrator/src/db/client.js'
