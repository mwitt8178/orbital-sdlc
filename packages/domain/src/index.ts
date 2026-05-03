/**
 * @orbital/domain — Aggregates, services, event store.
 *
 * Phase 3.4 of the migration plan: this package now physically contains the
 * major service factories that belong to the domain layer. Files were moved
 * from packages/orchestrator/src/ via `git mv`.
 *
 * Rules enforced by Phase 3.6 boundary lint:
 *   - domain may import from: types, db
 *   - domain must NOT import from: orchestrator-daemon, api-lambda, auth
 *
 * Note: some moved files still carry cross-package references back to
 * packages/orchestrator/src/ for modules that remain there (personas/,
 * orchestration/, hub-client/, config/). Those will be resolved in Phase 3.7.
 */

// Projects
export { createProjectsService } from './projects/service.js'

// Memory / knowledge graph
export { createMemoryService } from './memory/service.js'

// Backlog (stories + sprints)
export { createBacklogService } from './backlog/service.js'
export { createSprintService } from './backlog/sprint-service.js'

// UAT + defects + persona-of-record
export { createUATService } from './uat/service.js'
export { createDefectService } from './uat/defects.js'
export { createPersonaOfRecord } from './uat/persona-of-record.js'

// Event store
export { createEventStore } from './events/store.js'
export type { EventStore } from './events/store.js'

// Cost
export { createCostService } from './cost/service.js'

// Vision and Replay stay in @orbital/orchestrator until Phase 3.7.
// Consumers of createVisionService / createReplayService import directly
// from @orbital/orchestrator for now.
