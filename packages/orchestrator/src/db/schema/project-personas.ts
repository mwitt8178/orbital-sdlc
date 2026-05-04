/**
 * Phase 3.2 re-export shim.
 * Real implementation: packages/db/src/schema/project-personas.ts
 *
 * We re-export via the relative path (rather than the @orbital/db barrel)
 * because the orchestrator package's local tsc cannot resolve @orbital/db
 * during isolated typechecks; this resolves both at build and at runtime.
 */
export * from '../../../../db/src/schema/project-personas.js'
