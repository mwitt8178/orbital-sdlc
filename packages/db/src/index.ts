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

// Drizzle schema namespace — consumers import table definitions from here.
// Each schema file is re-exported as a named wildcard; import the specific
// table you need: `import { projects, tasks } from '@orbital/db'`.
export * from '../../orchestrator/src/db/schema/ac-check-evidence.js'
export * from '../../orchestrator/src/db/schema/audit.js'
export * from '../../orchestrator/src/db/schema/audit-export.js'
export * from '../../orchestrator/src/db/schema/backlog.js'
export * from '../../orchestrator/src/db/schema/board-mapping.js'
export * from '../../orchestrator/src/db/schema/capabilities.js'
export * from '../../orchestrator/src/db/schema/ceremony-triggers.js'
export * from '../../orchestrator/src/db/schema/channels.js'
export * from '../../orchestrator/src/db/schema/code-reviews.js'
export * from '../../orchestrator/src/db/schema/comms-workflow.js'
export * from '../../orchestrator/src/db/schema/cost.js'
export * from '../../orchestrator/src/db/schema/determinism.js'
export * from '../../orchestrator/src/db/schema/events.js'
export * from '../../orchestrator/src/db/schema/idempotency.js'
export * from '../../orchestrator/src/db/schema/known-installs.js'
export * from '../../orchestrator/src/db/schema/local-outbox.js'
export * from '../../orchestrator/src/db/schema/memory.js'
export * from '../../orchestrator/src/db/schema/onboarding.js'
export * from '../../orchestrator/src/db/schema/orchestration.js'
export * from '../../orchestrator/src/db/schema/personas.js'
export * from '../../orchestrator/src/db/schema/projects.js'
export * from '../../orchestrator/src/db/schema/replay.js'
export * from '../../orchestrator/src/db/schema/retros.js'
export * from '../../orchestrator/src/db/schema/routing.js'
export * from '../../orchestrator/src/db/schema/uat.js'
export * from '../../orchestrator/src/db/schema/vision.js'
export * from '../../orchestrator/src/db/schema/worker-tables.js'
