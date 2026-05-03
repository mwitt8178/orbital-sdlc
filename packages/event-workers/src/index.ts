/**
 * @orbital/event-workers — SNS/SQS consumer Lambda barrel.
 *
 * Phase 3.5 of the migration plan: each worker lives under
 * packages/orchestrator/src/lambda/consumers/ today. This shim lets consumers
 * already reference '@orbital/event-workers' in anticipation of the file
 * moves scheduled for Phase 3.5.
 *
 * Boundary constraint (enforced by Phase 3.6 eslint-plugin-boundaries):
 *   event-workers may import from: types, auth, db, domain
 *   event-workers must NOT import from: orchestrator, orchestrator-daemon, api-lambda
 *
 * Note: the actual handler exports are per-worker bundles, not this index.
 * This file exists so the boundaries rule can recognise the package element
 * and so TypeScript can resolve the package name.
 */

// Re-export handler entry points so each can be referenced individually.
// Replace with native imports after Phase 3.5 file moves.
export { handler as wsFanoutHandler } from '../../orchestrator/src/lambda/ws/fanout.js'
export { handler as auditIndexerHandler } from '../../orchestrator/src/lambda/consumers/audit-indexer.js'
export { handler as defectRouterHandler } from '../../orchestrator/src/lambda/consumers/defect-router.js'
export { handler as memoryRecorderHandler } from '../../orchestrator/src/lambda/consumers/memory-recorder.js'
export { handler as replayRecorderHandler } from '../../orchestrator/src/lambda/consumers/replay-recorder.js'
