/**
 * vault-sync/repo.ts — Drizzle repository for obsidian_vault_links.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Tenant isolation: every method takes tenantId and includes it in WHERE
 * clauses. There is no method that operates without a tenantId.
 */

import { and, eq } from 'drizzle-orm'
import { obsidianVaultLinks, type ObsidianVaultLinkRow } from '@orbital/db'
import type { DB } from '../db/client.js'
import type { VaultEntityType } from './types.js'

export interface VaultLinkUpsertInput {
  id: string
  tenantId: string
  projectId: string
  entityType: VaultEntityType
  entityId: string
  vaultPath: string
  frontmatter: Record<string, unknown>
  contentHash: string
}

export interface VaultLinkRepo {
  findByEntity(input: {
    tenantId: string
    projectId: string
    entityType: VaultEntityType
    entityId: string
  }): Promise<ObsidianVaultLinkRow | null>

  upsert(input: VaultLinkUpsertInput): Promise<ObsidianVaultLinkRow>

  listByProject(input: {
    tenantId: string
    projectId: string
  }): Promise<ObsidianVaultLinkRow[]>

  deleteByEntity(input: {
    tenantId: string
    projectId: string
    entityType: VaultEntityType
    entityId: string
  }): Promise<void>
}

export function createVaultLinkRepo(db: DB): VaultLinkRepo {
  return {
    async findByEntity({ tenantId, projectId, entityType, entityId }) {
      const rows = await db
        .select()
        .from(obsidianVaultLinks)
        .where(
          and(
            eq(obsidianVaultLinks.tenantId, tenantId),
            eq(obsidianVaultLinks.projectId, projectId),
            eq(obsidianVaultLinks.entityType, entityType),
            eq(obsidianVaultLinks.entityId, entityId),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async upsert(input) {
      const now = new Date()
      const rows = await db
        .insert(obsidianVaultLinks)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          projectId: input.projectId,
          entityType: input.entityType,
          entityId: input.entityId,
          vaultPath: input.vaultPath,
          frontmatter: input.frontmatter,
          contentHash: input.contentHash,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            obsidianVaultLinks.tenantId,
            obsidianVaultLinks.projectId,
            obsidianVaultLinks.entityType,
            obsidianVaultLinks.entityId,
          ],
          set: {
            vaultPath: input.vaultPath,
            frontmatter: input.frontmatter,
            contentHash: input.contentHash,
            lastSyncedAt: now,
            updatedAt: now,
          },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('vault-sync: upsert returned no row')
      return row
    },

    async listByProject({ tenantId, projectId }) {
      return db
        .select()
        .from(obsidianVaultLinks)
        .where(
          and(
            eq(obsidianVaultLinks.tenantId, tenantId),
            eq(obsidianVaultLinks.projectId, projectId),
          ),
        )
    },

    async deleteByEntity({ tenantId, projectId, entityType, entityId }) {
      await db
        .delete(obsidianVaultLinks)
        .where(
          and(
            eq(obsidianVaultLinks.tenantId, tenantId),
            eq(obsidianVaultLinks.projectId, projectId),
            eq(obsidianVaultLinks.entityType, entityType),
            eq(obsidianVaultLinks.entityId, entityId),
          ),
        )
    },
  }
}
