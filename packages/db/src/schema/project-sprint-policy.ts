/**
 * project-sprint-policy.ts — Drizzle schema for per-project sprint policy.
 *
 * [Engineer-Principal · Opus · run-settings-sprints]
 *
 * One row per project. Holds cadence, capacity, budget caps, and ceremony
 * rules. DSQL-safe: no FKs, additive table.
 */

import {
  pgTable,
  uuid,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

export const projectSprintPolicy = pgTable(
  'project_sprint_policy',
  {
    projectId: uuid('project_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    /** 1, 2, 3, or 4 — sprint length in weeks. */
    lengthWeeks: integer('length_weeks').notNull().default(2),
    /** 0=Sun..6=Sat — day of week sprints start. */
    startDow: integer('start_dow').notNull().default(1),
    /** When true, completing a sprint auto-creates the next one. */
    autoAdvance: boolean('auto_advance').notNull().default(false),
    /** Default story-point capacity for a sprint. */
    pointsPerSprint: integer('points_per_sprint').notNull().default(20),
    /** Per-sprint budget cap in USD cents. 0 = no cap. */
    budgetUsdCentsPerSprint: bigint('budget_usd_cents_per_sprint', { mode: 'number' })
      .notNull()
      .default(0),
    /** Per-week budget cap in USD cents. 0 = no cap. */
    budgetUsdCentsPerWeek: bigint('budget_usd_cents_per_week', { mode: 'number' })
      .notNull()
      .default(0),
    /** Ceremony rules object. See trpc/routers/sprint-policy.ts for the Zod shape. */
    ceremonyRules: jsonb('ceremony_rules').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byTenant: index('psp_tenant_idx').on(t.tenantId),
  }),
)

export type ProjectSprintPolicyRow = typeof projectSprintPolicy.$inferSelect
export type ProjectSprintPolicyInsert = typeof projectSprintPolicy.$inferInsert
