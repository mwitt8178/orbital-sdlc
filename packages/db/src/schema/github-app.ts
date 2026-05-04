/**
 * github-app.ts — Drizzle schema for the GitHub App integration.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 *
 * Three tables, all additive, all DSQL-compliant (no FKs, no SERIAL, no
 * triggers, UUIDv7 generated in app code, clock_timestamp() defaults).
 *
 * Multi-tenant: every row carries `tenant_id`. Sentinel
 * '00000000-0000-0000-0000-000000000000' = local-install default, matching
 * the rest of the schema.
 */

import {
  pgTable,
  bigint,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const githubInstallations = pgTable(
  'github_installations',
  {
    installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    githubAccountLogin: text('github_account_login').notNull(),
    githubAccountType: text('github_account_type').notNull(), // 'User' | 'Organization'
    githubAccountId: bigint('github_account_id', { mode: 'number' }).notNull(),
    permissions: jsonb('permissions').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    installedByUserId: uuid('installed_by_user_id'),
    installedAt: timestamp('installed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'date' }),
    uninstalledAt: timestamp('uninstalled_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    byTenant: index('github_installations_tenant_idx').on(t.tenantId),
  }),
)

export const githubRepoBindings = pgTable(
  'github_repo_bindings',
  {
    bindingId: uuid('binding_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    projectId: uuid('project_id').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    byProject: index('github_repo_bindings_project_idx').on(t.projectId),
    byTenant: index('github_repo_bindings_tenant_idx').on(t.tenantId),
    // Partial unique idx — only enforce uniqueness for active bindings.
    activeUnique: uniqueIndex('github_repo_bindings_unique_active')
      .on(t.projectId, t.githubRepoId)
      .where(sql`removed_at IS NULL`),
  }),
)

export const githubWebhookDeliveries = pgTable(
  'github_webhook_deliveries',
  {
    deliveryId: text('delivery_id').primaryKey(), // X-GitHub-Delivery
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    installationId: bigint('installation_id', { mode: 'number' }),
    eventType: text('event_type').notNull(),
    action: text('action'),
    payloadSha256: text('payload_sha256').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    result: text('result'), // 'ok' | 'duplicate' | 'invalid_sig' | 'error'
  },
  (t) => ({
    byReceived: index('github_webhook_deliveries_received_idx').on(t.receivedAt),
  }),
)

export type GithubInstallationRow = typeof githubInstallations.$inferSelect
export type GithubInstallationInsert = typeof githubInstallations.$inferInsert
export type GithubRepoBindingRow = typeof githubRepoBindings.$inferSelect
export type GithubRepoBindingInsert = typeof githubRepoBindings.$inferInsert
export type GithubWebhookDeliveryRow = typeof githubWebhookDeliveries.$inferSelect
export type GithubWebhookDeliveryInsert = typeof githubWebhookDeliveries.$inferInsert
