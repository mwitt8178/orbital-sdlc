/**
 * trpc/routers/vault.ts — Obsidian vault sync tRPC router.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Procedures:
 *   vault.status         (query)    — feature flag + last sync per project
 *   vault.syncProject    (mutation) — push every entity for a project to S3
 *   vault.downloadZip    (mutation) — build ZIP, return signed URL or base64
 *   vault.listForPlugin  (query)    — manifest + signed URL per file (plugin)
 *
 * All procedures are tenant-scoped. The vault feature flag (ORBITAL_VAULT_ENABLED)
 * gates every procedure; when off, calls return FAILED_PRECONDITION.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import type { VaultSyncService } from '../../vault-sync/service.js'
import type { VaultStore } from '../../vault-sync/store.js'
import type { ProjectEntitySource } from '../../vault-sync/entity-source.js'
import type { VaultLinkRepo } from '../../vault-sync/repo.js'
import { buildVaultZip } from '../../vault-sync/zip.js'
import { vaultManifestKey, vaultS3Key } from '../../vault-sync/key.js'

export interface VaultRouterDeps {
  vaultSyncService: VaultSyncService
  store: VaultStore
  entitySource: ProjectEntitySource
  repo: VaultLinkRepo
}

export function createVaultRouter(deps: VaultRouterDeps) {
  const { vaultSyncService, store, entitySource, repo } = deps

  function ensureEnabled() {
    const env = loadEnv()
    if (env.ORBITAL_VAULT_ENABLED !== 'on') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Obsidian vault sync is disabled. Set ORBITAL_VAULT_ENABLED=on and configure ORBITAL_VAULT_BUCKET.',
      })
    }
  }

  return router({
    // -----------------------------------------------------------------------
    // vault.status — quick check for the UI card.
    // -----------------------------------------------------------------------
    status: tenantProcedure
      .input(z.object({ projectId: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        const env = loadEnv()
        const enabled = env.ORBITAL_VAULT_ENABLED === 'on'
        if (!enabled) {
          return { enabled: false, lastSyncedAt: null, entityCount: 0 }
        }
        const links = await repo.listByProject({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
        })
        const lastSyncedAt = links.reduce<Date | null>((acc, l) => {
          if (!acc) return l.lastSyncedAt
          return l.lastSyncedAt > acc ? l.lastSyncedAt : acc
        }, null)
        return {
          enabled: true,
          lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
          entityCount: links.length,
        }
      }),

    // -----------------------------------------------------------------------
    // vault.syncProject — push every entity to S3.
    // -----------------------------------------------------------------------
    syncProject: tenantProcedure
      .input(z.object({ projectId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        ensureEnabled()
        try {
          const { projectSlug, entities } = await entitySource.listForProject({
            tenantId: ctx.tenantId,
            projectId: input.projectId,
          })
          const result = await vaultSyncService.syncProject({
            tenantId: ctx.tenantId,
            projectId: input.projectId,
            projectSlug,
            entities,
          })
          logger.info(
            {
              tenantId: ctx.tenantId,
              projectId: input.projectId,
              entityCount: entities.length,
              writtenCount: result.results.filter((r) => r.written).length,
            },
            'vault.syncProject complete',
          )
          return {
            entityCount: result.results.length,
            writtenCount: result.results.filter((r) => r.written).length,
            manifestKey: result.manifestKey,
          }
        } catch (err) {
          logger.error(
            { err, tenantId: ctx.tenantId, projectId: input.projectId },
            'vault.syncProject failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Vault sync failed',
          })
        }
      }),

    // -----------------------------------------------------------------------
    // vault.downloadZip — build a ZIP of every entity and return a signed URL.
    //
    // We materialise the ZIP into S3 under
    //   {tenantId}/projects/{slug}/.orbital/exports/{timestamp}.zip
    // and return a 15-minute pre-signed GET URL.
    // -----------------------------------------------------------------------
    downloadZip: tenantProcedure
      .input(z.object({ projectId: z.string().uuid() }))
      .mutation(async ({ input, ctx }) => {
        ensureEnabled()
        try {
          const { projectSlug, entities } = await entitySource.listForProject({
            tenantId: ctx.tenantId,
            projectId: input.projectId,
          })
          const zip = await buildVaultZip({
            tenantId: ctx.tenantId,
            projectId: input.projectId,
            projectSlug,
            entities,
          })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const key = vaultS3Key({
            tenantId: ctx.tenantId,
            projectSlug: zip.manifest.project_slug,
            type: 'memory', // folder is forced by the next line
            basename: `__export__${stamp}`,
          }).replace(/\/memory\/[^/]+\.md$/, `/.orbital/exports/${stamp}.zip`)

          await store.put({
            key,
            body: zip.buffer.toString('binary'),
            contentType: 'application/zip',
            metadata: {
              'orbital-tenant-id': ctx.tenantId,
              'orbital-project-id': input.projectId,
              'orbital-vault-export': '1',
            },
          })
          const url = await store.signedDownloadUrl(key, 15 * 60)
          return {
            url,
            filename: zip.filename,
            entityCount: entities.length,
          }
        } catch (err) {
          logger.error(
            { err, tenantId: ctx.tenantId, projectId: input.projectId },
            'vault.downloadZip failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Vault export failed',
          })
        }
      }),

    // -----------------------------------------------------------------------
    // vault.listForPlugin — what the Obsidian plugin reads.
    //
    // Returns the per-project manifest plus signed URLs for every file the
    // plugin should pull. This is the mode-(1) S3-backed sync surface.
    // -----------------------------------------------------------------------
    listForPlugin: tenantProcedure
      .input(z.object({ projectId: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        ensureEnabled()
        const links = await repo.listByProject({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
        })
        if (links.length === 0) {
          return { manifestUrl: null, files: [] }
        }
        const projectSlug = links[0]?.vaultPath.split('/')[1] ?? 'unknown'
        const manifestKey = vaultManifestKey({ tenantId: ctx.tenantId, projectSlug })
        const manifestUrl = await store.signedDownloadUrl(manifestKey, 15 * 60)
        const files = await Promise.all(
          links.map(async (l) => ({
            path: l.vaultPath,
            type: l.entityType,
            id: l.entityId,
            hash: l.contentHash,
            url: await store.signedDownloadUrl(`${ctx.tenantId}/${l.vaultPath}`, 15 * 60),
          })),
        )
        return { manifestUrl, files }
      }),
  })
}

export type VaultRouter = ReturnType<typeof createVaultRouter>
