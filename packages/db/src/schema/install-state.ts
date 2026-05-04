/**
 * install-state.ts — Drizzle schema for the onboarding overlay table.
 *
 * Replaces the per-instance filesystem overlay
 * (~/.orbital/config/onboarding.json → /tmp/... in Lambda) with a tenant-scoped
 * Aurora table so SetupGate is consistent across Lambda instances.
 *
 * [Engineer-Principal · Opus · run-install-state-aurora]
 *
 * One row per install. mode/setup_completed_at/demo_replay_id are nullable
 * because a fresh install has no overlay state until the wizard advances.
 *
 * No FKs (DSQL discipline); install_id is opaque to other aggregates.
 */

import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core'

export const installState = pgTable(
  'install_state',
  {
    installId: uuid('install_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    schemaVersion: integer('schema_version').notNull().default(1),
    mode: text('mode', { enum: ['demo', 'live', 'readonly'] }),
    setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true, mode: 'date' }),
    demoReplayId: text('demo_replay_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byTenant: index('install_state_tenant_idx').on(t.tenantId),
  }),
)

export type InstallStateRow = typeof installState.$inferSelect
export type InstallStateInsert = typeof installState.$inferInsert
