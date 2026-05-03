/**
 * @orbital/domain — Aggregates, services, event store.
 *
 * Phase 3.4 of the migration plan: this package collects the major service
 * factories that belong to the domain layer. Until the file moves are
 * complete (Phase 3.7), this barrel re-exports from the orchestrator package
 * so consumers can already `import from '@orbital/domain'`.
 *
 * Rules enforced by Phase 3.6 boundary lint:
 *   - domain may import from: types, db
 *   - domain must NOT import from: orchestrator-daemon, api-lambda, auth
 *
 * Replace each re-export below with a native import after the file moves.
 */

// Projects
export { createProjectsService } from '../../orchestrator/src/projects/service.js'

// Memory / knowledge graph
export { createMemoryService } from '../../orchestrator/src/memory/service.js'

// Backlog (stories + sprints)
export { createBacklogService } from '../../orchestrator/src/backlog/service.js'
export { createSprintService } from '../../orchestrator/src/backlog/sprint-service.js'

// UAT + defects + persona-of-record
export { createUATService } from '../../orchestrator/src/uat/service.js'
export { createDefectService } from '../../orchestrator/src/uat/defects.js'
export { createPersonaOfRecord } from '../../orchestrator/src/uat/persona-of-record.js'

// Event store
export { createEventStore } from '../../orchestrator/src/events/store.js'
export type { EventStore } from '../../orchestrator/src/events/store.js'

// Cost
export { createCostService } from '../../orchestrator/src/cost/service.js'

// Vision
export { createVisionService } from '../../orchestrator/src/vision/service.js'

// Replay
export { createReplayService } from '../../orchestrator/src/replay/service.js'
