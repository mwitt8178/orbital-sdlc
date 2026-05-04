/**
 * obsidian-vault-links.ts — Drizzle schema for the Obsidian vault sync ledger.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * One row per (tenant_id, project_id, entity_type, entity_id) tracking the
 * last vault path + frontmatter + content hash written to the vault (S3 or
 * exported ZIP). Derived from source aggregates; never authoritative.
 *
 * Composite uniqueness on (tenant_id, project_id, entity_type, entity_id)
 * enables idempotent ON CONFLICT DO UPDATE upserts during sync.
 */

import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const obsidianVaultLinks = pgTable(
  'obsidian_vault_links',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    vaultPath: text('vault_path').notNull(),
    frontmatter: jsonb('frontmatter').notNull().default({}),
    contentHash: text('content_hash').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityUniq: uniqueIndex('obsidian_vault_links_entity_uniq').on(
      t.tenantId,
      t.projectId,
      t.entityType,
      t.entityId,
    ),
    tenantProjectIdx: index('obsidian_vault_links_tenant_project_idx').on(t.tenantId, t.projectId),
    pathIdx: index('obsidian_vault_links_path_idx').on(t.tenantId, t.projectId, t.vaultPath),
  }),
)

export type ObsidianVaultLinkRow = typeof obsidianVaultLinks.$inferSelect
export type ObsidianVaultLinkInsert = typeof obsidianVaultLinks.$inferInsert

/**
 * Vault entity types — must match the SQL CHECK constraint.
 */
export const VAULT_ENTITY_TYPES = ['vision', 'epic', 'story', 'ac', 'retro', 'memory'] as const
export type VaultEntityType = (typeof VAULT_ENTITY_TYPES)[number]
