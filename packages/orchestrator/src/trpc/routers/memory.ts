/**
 * trpc/routers/memory.ts — Memory tRPC router.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Procedures:
 *   memory.record     (mutation) — create a new memory entry
 *   memory.get        (query)    — get one by ID
 *   memory.list       (query)    — paginated list with search/filter
 *   memory.search     (query)    — semantic/tag-based search
 *   memory.update     (mutation) — curate an existing entry
 *   memory.archive    (mutation) — soft-delete
 *   memory.supersede  (mutation) — mark as superseded by another entry
 *
 * Round 7-02 — hub proxy: all procedures proxy to hub when ORBITAL_HUB_URL set.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { OrbitalError } from '@orbital/types'
import { router } from '../init.js'
// Round 7-01 — tenant-scoped memory procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
import { tenantProcedure } from '../middleware/tenant.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import type { MemoryService } from '../../memory/service.js'
import { retrieveTopN } from '../../memory/retrieval.js'
import type { DB } from '../../db/client.js'
import {
  CreateMemoryEntryInputSchema,
  UpdateMemoryEntryInputSchema,
  ListMemoryEntriesInputSchema,
  SearchMemoryInputSchema,
  ArchiveMemoryEntryInputSchema,
  SupersedeMemoryEntryInputSchema,
  type MemoryEntry,
} from '../../memory/types.js'

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface MemoryRouterDeps {
  memoryService: MemoryService
  db: DB
}

export function createMemoryRouter(deps: MemoryRouterDeps) {
  const { memoryService, db } = deps

  return router({
    // -----------------------------------------------------------------------
    // memory.record — create a new entry
    // Round 7-01: tenant-scoped. [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
    // -----------------------------------------------------------------------
    record: projectProcedure
      .input(CreateMemoryEntryInputSchema)
      .mutation(async ({ input, ctx }) => {
        // fix/multi-project-isolation — input.projectId must match active project
        if (input.projectId !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'projectId mismatch between input and active project header',
          })
        }
        // Round 7-02 — hub proxy
        // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
        const hub = getHubClient()
        if (hub !== null) {
          const result = await hub.mutate<{ entry: unknown }>('memory.record', input, ctx.tenantId!)
          if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
          return result.data
        }

        try {
          const entry = await memoryService.record(input, 'operator', ctx.tenantId!)
          return { entry }
        } catch (err) {
          if (err instanceof OrbitalError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to record memory entry' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.get — fetch a single entry by ID
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    get: projectProcedure
      .input(z.object({ entryId: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        // Round 7-02 — hub proxy
        const hub = getHubClient()
        if (hub !== null) {
          const result = await hub.query<{ entry: MemoryEntry }>('memory.get', input, ctx.tenantId!)
          if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
          return result.data
        }

        try {
          const entry = await memoryService.get(input.entryId, ctx.tenantId!)
          return { entry }
        } catch (err) {
          if (err instanceof OrbitalError && err.code === 'NOT_FOUND_MEMORY_ENTRY') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch memory entry' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.list — paginated list with filter/search
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    list: projectProcedure
      .input(ListMemoryEntriesInputSchema)
      .query(async ({ input, ctx }) => {
        // fix/multi-project-isolation
        if (input.projectId !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'projectId mismatch between input and active project header',
          })
        }
        // Round 7-02 — hub proxy
        const hub = getHubClient()
        if (hub !== null) {
          type ListResult = Awaited<ReturnType<typeof memoryService.list>>
          const proxyResult = await hub.query<ListResult>('memory.list', input, ctx.tenantId!)
          if (!proxyResult.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: proxyResult.message })
          return proxyResult.data
        }

        try {
          const result = await memoryService.list(input, ctx.tenantId!)
          return result
        } catch (err) {
          if (err instanceof OrbitalError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list memory entries' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.search — semantic/tag-based retrieval
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    search: projectProcedure
      .input(SearchMemoryInputSchema)
      .query(async ({ input, ctx }) => {
        // fix/multi-project-isolation
        if (input.projectId !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'projectId mismatch between input and active project header',
          })
        }
        try {
          // Pass tenantId for explicit multi-tenant isolation in retrieveTopN.
          // [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
          const result = await retrieveTopN(
            db,
            input.projectId,
            { title: input.query, description: input.query },
            input.k,
            { tenantId: ctx.tenantId },
          )
          return { entries: result.entries, method: result.method }
        } catch (err) {
          if (err instanceof OrbitalError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to search memory entries' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.update — curate an existing entry (operator only)
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    update: projectProcedure
      .input(UpdateMemoryEntryInputSchema)
      .mutation(async ({ input, ctx }) => {
        // fix/multi-project-isolation — only enforce if input has projectId
        const inputProjectId = (input as { projectId?: string }).projectId
        if (inputProjectId && inputProjectId !== ctx.projectId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'projectId mismatch between input and active project header',
          })
        }
        try {
          const entry = await memoryService.update(input, 'operator', ctx.tenantId!)
          return { entry }
        } catch (err) {
          if (err instanceof OrbitalError && err.code === 'NOT_FOUND_MEMORY_ENTRY') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
          }
          if (err instanceof OrbitalError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to update memory entry' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.archive — soft-delete an entry
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    archive: projectProcedure
      .input(ArchiveMemoryEntryInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          await memoryService.archive(input.entryId, 'operator', ctx.tenantId!)
          return { success: true }
        } catch (err) {
          if (err instanceof OrbitalError && err.code === 'NOT_FOUND_MEMORY_ENTRY') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to archive memory entry' })
        }
      }),

    // -----------------------------------------------------------------------
    // memory.supersede — mark as superseded
    // Round 7-01: tenant-scoped.
    // -----------------------------------------------------------------------
    supersede: projectProcedure
      .input(SupersedeMemoryEntryInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          await memoryService.supersede(input.entryId, input.supersededByEntryId, 'operator', ctx.tenantId!)
          return { success: true }
        } catch (err) {
          if (err instanceof OrbitalError && err.code === 'NOT_FOUND_MEMORY_ENTRY') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
          }
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to supersede memory entry' })
        }
      }),
  })
}

export type MemoryRouter = ReturnType<typeof createMemoryRouter>
