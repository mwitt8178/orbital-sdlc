/**
 * vault-sync/zip.ts — Build a tenant-scoped vault ZIP for download.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Mode (2) of the spec: users who manage their own vault click
 * "Download vault" and get a ZIP they extract into their Obsidian vault.
 *
 * Tenant safety: this function takes a list of entities + a tenantId and
 * walks ONLY those entities — it does not iterate the database itself.
 * The caller (tRPC router) is responsible for fetching tenant-scoped
 * entities; this is a pure transform.
 */

import JSZip from 'jszip'
import { renderMarkdown, contentHash } from './markdown.js'
import { kebabify, vaultRelativePath } from './key.js'
import type {
  VaultEntity,
  ProjectVaultManifest,
  ProjectVaultManifestEntry,
} from './types.js'

export interface BuildVaultZipInput {
  tenantId: string
  projectId: string
  projectSlug: string
  entities: VaultEntity[]
}

export interface BuildVaultZipResult {
  buffer: Buffer
  manifest: ProjectVaultManifest
  filename: string
}

export async function buildVaultZip(input: BuildVaultZipInput): Promise<BuildVaultZipResult> {
  const { tenantId, projectId, projectSlug, entities } = input
  if (!tenantId) throw new Error('vault-sync: tenantId is required')
  for (const e of entities) {
    if (e.tenantId !== tenantId) {
      throw new Error(
        `vault-sync: entity.tenantId (${e.tenantId}) does not match input.tenantId (${tenantId})`,
      )
    }
  }

  const slug = kebabify(projectSlug)
  const zip = new JSZip()
  const manifestEntries: ProjectVaultManifestEntry[] = []

  for (const entity of entities) {
    const rendered = renderMarkdown(entity)
    const hash = contentHash(rendered)
    const path = vaultRelativePath({
      projectSlug: slug,
      type: entity.type,
      basename: entity.title,
    })
    zip.file(path, rendered)
    manifestEntries.push({
      type: entity.type,
      id: entity.id,
      path,
      hash,
      updated_at: entity.updatedAt ?? new Date().toISOString(),
    })
  }

  const manifest: ProjectVaultManifest = {
    tenant_id: tenantId,
    project_id: projectId,
    project_slug: slug,
    generated_at: new Date().toISOString(),
    entries: manifestEntries,
  }
  zip.file(`projects/${slug}/.orbital/manifest.json`, JSON.stringify(manifest, null, 2))

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return {
    buffer,
    manifest,
    filename: `orbital-vault-${slug}-${new Date().toISOString().slice(0, 10)}.zip`,
  }
}
