/**
 * db/schema/vision-decomposition-runs.ts — Drizzle schema for vision_decomposition_runs.
 *
 * Tracks the user-facing lifecycle of a vision → backlog decomposition run:
 *   pending → approved | discarded | failed
 *
 * This is a lighter companion to planning_runs (0040) which holds the full
 * LLM audit trail (tokens, cost, raw_response). vision_decomposition_runs adds
 * project_id scoping and an explicit user-approval status so the UI can gate on
 * "Approve" / "Discard" without scanning the heavier planning_runs table.
 *
 * Multi-tenant: tenant_id + project_id on every row. tenant_id defaults to the
 * sentinel UUID for single-install deployments.
 *
 * [Engineer-Sr · Sonnet · run-vision-decompose]
 */

import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core'

export const VISION_DECOMPOSITION_RUN_STATUS = [
  'pending',
  'approved',
  'discarded',
  'failed',
] as const

export type VisionDecompositionRunStatus = (typeof VISION_DECOMPOSITION_RUN_STATUS)[number]

export const visionDecompositionRuns = pgTable(
  'vision_decomposition_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    projectId: uuid('project_id'),
    visionId: uuid('vision_id').notNull(),
    status: text('status', { enum: VISION_DECOMPOSITION_RUN_STATUS }).notNull().default('pending'),
    epicCount: integer('epic_count'),
    storyCount: integer('story_count'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    error: text('error'),
  },
  (t) => ({
    byTenantVision: index('vdr_tenant_vision_idx').on(t.tenantId, t.visionId, t.startedAt),
    byTenantProject: index('vdr_tenant_project_idx').on(t.tenantId, t.projectId, t.startedAt),
  }),
)

export type VisionDecompositionRunRow = typeof visionDecompositionRuns.$inferSelect
export type VisionDecompositionRunInsert = typeof visionDecompositionRuns.$inferInsert
