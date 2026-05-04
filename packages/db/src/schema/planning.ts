/**
 * db/schema/planning.ts — drizzle schema for planning_runs.
 *
 * Audit trail for LLM-backed vision decomposition. See migration 0040.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 */

import { pgTable, uuid, integer, timestamp, text, jsonb, index } from 'drizzle-orm/pg-core'

export const planningRuns = pgTable(
  'planning_runs',
  {
    runId: uuid('run_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    visionId: uuid('vision_id').notNull(),
    visionVersion: integer('vision_version').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    usdCents: integer('usd_cents'),
    exitStatus: text('exit_status').notNull().default('pending'),
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    byTenantVision: index('planning_runs_tenant_vision_idx').on(
      t.tenantId,
      t.visionId,
      t.startedAt,
    ),
  }),
)

export type PlanningRunRow = typeof planningRuns.$inferSelect
export type PlanningRunInsert = typeof planningRuns.$inferInsert
