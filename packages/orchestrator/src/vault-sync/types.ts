/**
 * vault-sync/types.ts — Domain types for Obsidian vault projection.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * The vault-sync bounded context owns the projection from Orbital aggregates
 * (vision/epic/story/ac/retro/memory) to a markdown vault that Obsidian can
 * open. Source aggregates remain authoritative — vault-sync only writes.
 *
 * Tenant isolation is enforced by always prefixing S3 keys with the tenant
 * id; see `vaultS3Key` in `key.ts`.
 */

import { z } from 'zod'

export const VAULT_ENTITY_TYPES = ['vision', 'epic', 'story', 'ac', 'retro', 'memory'] as const
export type VaultEntityType = (typeof VAULT_ENTITY_TYPES)[number]

/**
 * Frontmatter written to every vault file. Validated on read + write so a
 * corrupted file fails loudly rather than silently dropping fields.
 */
export const FrontmatterSchema = z.object({
  orbital_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  project_id: z.string().uuid(),
  type: z.enum(VAULT_ENTITY_TYPES),
  title: z.string(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  /** Wikilinks to other entities — `[[other-title]]` form, no extension. */
  links: z.array(z.string()).default([]),
  /** Free-form tags, kebab-case. */
  tags: z.array(z.string()).default([]),
})
export type Frontmatter = z.infer<typeof FrontmatterSchema>

/**
 * A single entity to be projected into the vault.
 * Source-aggregate-agnostic — the sync service is given a pre-shaped record.
 */
export interface VaultEntity {
  type: VaultEntityType
  id: string
  tenantId: string
  projectId: string
  title: string
  /** Markdown body — NOT including frontmatter. */
  body: string
  status?: string
  createdAt?: string
  updatedAt?: string
  /** Wikilinks to render in frontmatter (`[[Other Title]]` style). */
  links?: string[]
  tags?: string[]
}

export interface VaultSyncResult {
  entityType: VaultEntityType
  entityId: string
  vaultPath: string
  contentHash: string
  /** True if the entity was actually written this run; false if hash unchanged. */
  written: boolean
}

export interface ProjectVaultManifestEntry {
  type: VaultEntityType
  id: string
  path: string
  hash: string
  updated_at: string
}

export interface ProjectVaultManifest {
  tenant_id: string
  project_id: string
  project_slug: string
  generated_at: string
  entries: ProjectVaultManifestEntry[]
}
