/**
 * @orbital/db — Aurora client + Drizzle schema barrel.
 *
 * Phase 3.2: files physically moved from packages/orchestrator/src/db/ to
 * packages/db/src/. This barrel now re-exports from local relative paths.
 *
 * Phase 3.6 will enforce that no consumer imports DB code from the legacy
 * orchestrator path; this barrel is the only entry point.
 */

// DB client
export { getDb, closeDb, sql, db } from './client.js'
export type { DB } from './client.js'

// Drizzle schema namespace — consumers import table definitions from here.
// Each schema file is re-exported as a named wildcard; import the specific
// table you need: `import { projects, tasks } from '@orbital/db'`.
export * from './schema/ac-check-evidence.js'
export * from './schema/audit.js'
export * from './schema/audit-export.js'
export * from './schema/backlog.js'
export * from './schema/board-mapping.js'
export * from './schema/capabilities.js'
export * from './schema/ceremony-triggers.js'
export * from './schema/channels.js'
export * from './schema/code-reviews.js'
export * from './schema/comms-workflow.js'
export * from './schema/cost.js'
export * from './schema/determinism.js'
export * from './schema/events.js'
export * from './schema/idempotency.js'
export * from './schema/install-state.js'
export * from './schema/known-installs.js'
export * from './schema/local-outbox.js'
export * from './schema/memory.js'
export * from './schema/onboarding.js'
export * from './schema/orchestration.js'
export * from './schema/personas.js'
export * from './schema/projects.js'
export * from './schema/replay.js'
export * from './schema/retros.js'
export * from './schema/routing.js'
export * from './schema/uat.js'
export * from './schema/vision.js'
export * from './schema/worker-tables.js'
export * from './schema/github-app.js'
export * from './schema/planning.js'
export * from './schema/tenant-credentials.js'
export * from './schema/vision-decomposition-runs.js'
