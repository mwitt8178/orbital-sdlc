/**
 * Drizzle schema for the project_personas override table.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * Per-project persona configuration: enabled flag, preferred model, per-task
 * budget cap, optional system-prompt override, ordering for routing claim.
 *
 * Composite PK (tenant_id, project_id, persona_slug). No FKs (DSQL discipline).
 */

import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'

export const projectPersonas = pgTable(
  'project_personas',
  {
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    projectId: uuid('project_id').notNull(),
    personaSlug: text('persona_slug').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    model: text('model').notNull().default('claude-sonnet-4-6'),
    budgetUsdCents: integer('budget_usd_cents').notNull().default(500),
    systemPromptOverride: text('system_prompt_override'),
    ordering: integer('ordering').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.projectId, t.personaSlug] }),
    projectIdx: index('project_personas_project_idx').on(t.projectId),
    tenantProjectIdx: index('project_personas_tenant_project_idx').on(t.tenantId, t.projectId),
  }),
)

export type ProjectPersonaRow = typeof projectPersonas.$inferSelect
export type ProjectPersonaInsert = typeof projectPersonas.$inferInsert
