/**
 * vault-sync/service.ts — Sync orchestration.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Responsibilities:
 *   - Render a VaultEntity → markdown (deterministic).
 *   - Compute content_hash; short-circuit if unchanged.
 *   - PUT to S3 / write to local store.
 *   - Upsert obsidian_vault_links ledger row.
 *   - Build a per-project manifest.json the plugin reads.
 *
 * Out of scope here (lands in v2):
 *   - Outbox-driven incremental sync.
 *   - Pulling from vault back into source aggregates.
 */

import { uuidv7 } from 'uuidv7'
import {
  vaultS3Key,
  vaultManifestKey,
  kebabify,
  vaultRelativePath,
} from './key.js'
import { renderMarkdown, contentHash } from './markdown.js'
import type {
  VaultEntity,
  VaultSyncResult,
  ProjectVaultManifest,
  ProjectVaultManifestEntry,
} from './types.js'
import type { VaultStore } from './store.js'
import type { VaultLinkRepo } from './repo.js'

export interface VaultSyncDeps {
  store: VaultStore
  repo: VaultLinkRepo
}

export interface SyncProjectInput {
  tenantId: string
  projectId: string
  projectSlug: string
  entities: VaultEntity[]
}

export interface SyncProjectResult {
  results: VaultSyncResult[]
  manifestKey: string
  manifest: ProjectVaultManifest
}

export interface VaultSyncService {
  /** Sync one entity. Idempotent — no-op if content_hash unchanged. */
  syncEntity(entity: VaultEntity, projectSlug: string): Promise<VaultSyncResult>

  /** Sync every entity for a project + write the per-project manifest. */
  syncProject(input: SyncProjectInput): Promise<SyncProjectResult>
}

export function createVaultSyncService(deps: VaultSyncDeps): VaultSyncService {
  const { store, repo } = deps

  async function syncEntity(entity: VaultEntity, projectSlug: string): Promise<VaultSyncResult> {
    if (entity.tenantId !== entity.tenantId || !entity.tenantId) {
      throw new Error('vault-sync: entity.tenantId is required')
    }
    const rendered = renderMarkdown(entity)
    const hash = contentHash(rendered)
    const key = vaultS3Key({
      tenantId: entity.tenantId,
      projectSlug,
      type: entity.type,
      basename: entity.title,
    })
    const relPath = vaultRelativePath({
      projectSlug,
      type: entity.type,
      basename: entity.title,
    })

    const existing = await repo.findByEntity({
      tenantId: entity.tenantId,
      projectId: entity.projectId,
      entityType: entity.type,
      entityId: entity.id,
    })

    if (existing && existing.contentHash === hash && existing.vaultPath === relPath) {
      // No write needed.
      return {
        entityType: entity.type,
        entityId: entity.id,
        vaultPath: relPath,
        contentHash: hash,
        written: false,
      }
    }

    await store.put({
      key,
      body: rendered,
      contentType: 'text/markdown; charset=utf-8',
      metadata: {
        'orbital-tenant-id': entity.tenantId,
        'orbital-project-id': entity.projectId,
        'orbital-type': entity.type,
        'orbital-id': entity.id,
        'orbital-content-hash': hash,
      },
    })

    await repo.upsert({
      id: existing?.id ?? uuidv7(),
      tenantId: entity.tenantId,
      projectId: entity.projectId,
      entityType: entity.type,
      entityId: entity.id,
      vaultPath: relPath,
      frontmatter: {
        orbital_id: entity.id,
        type: entity.type,
        title: entity.title,
        status: entity.status ?? null,
        tags: entity.tags ?? [],
        links: entity.links ?? [],
      },
      contentHash: hash,
    })

    return {
      entityType: entity.type,
      entityId: entity.id,
      vaultPath: relPath,
      contentHash: hash,
      written: true,
    }
  }

  async function syncProject(input: SyncProjectInput): Promise<SyncProjectResult> {
    const { tenantId, projectId, projectSlug, entities } = input
    if (!tenantId) throw new Error('vault-sync: tenantId is required')
    if (!projectSlug) throw new Error('vault-sync: projectSlug is required')

    const slug = kebabify(projectSlug)
    const results: VaultSyncResult[] = []
    for (const entity of entities) {
      if (entity.tenantId !== tenantId) {
        throw new Error(
          `vault-sync: entity.tenantId (${entity.tenantId}) does not match input.tenantId (${tenantId})`,
        )
      }
      results.push(await syncEntity(entity, slug))
    }

    const manifestEntries: ProjectVaultManifestEntry[] = results.map((r) => ({
      type: r.entityType,
      id: r.entityId,
      path: r.vaultPath,
      hash: r.contentHash,
      updated_at: new Date().toISOString(),
    }))

    const manifest: ProjectVaultManifest = {
      tenant_id: tenantId,
      project_id: projectId,
      project_slug: slug,
      generated_at: new Date().toISOString(),
      entries: manifestEntries,
    }

    const manifestKey = vaultManifestKey({ tenantId, projectSlug: slug })
    await store.put({
      key: manifestKey,
      body: JSON.stringify(manifest, null, 2),
      contentType: 'application/json',
      metadata: { 'orbital-tenant-id': tenantId, 'orbital-project-id': projectId },
    })

    return { results, manifestKey, manifest }
  }

  return { syncEntity, syncProject }
}

export type { VaultStore } from './store.js'
export type { VaultLinkRepo } from './repo.js'
export {
  vaultS3Key,
  vaultS3Prefix,
  vaultManifestKey,
  kebabify,
} from './key.js'
export { renderMarkdown, parseMarkdown, contentHash } from './markdown.js'
