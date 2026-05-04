/**
 * trpc/routers/projects.ts — Projects tRPC router.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Procedures:
 *   projects.list                  (query)    — list projects within install
 *   projects.get                   (query)    — get one by id
 *   projects.getActive             (query)    — get the active project (per header)
 *   projects.create                (mutation) — create with optional Monday/Github
 *   projects.update                (mutation) — patch name/description
 *   projects.archive               (mutation) — soft-delete
 *   projects.connectMonday         (mutation) — bind a Monday board
 *   projects.connectGithub         (mutation) — bind a Github repo
 *   projects.testMondayConnection  (query)    — pre-flight by board id
 *   projects.testGithubConnection  (query)    — pre-flight by owner+repo
 *
 * No capability gating in v1 (single-tenant local install). Mutations write
 * events through ProjectsService → EventStore.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { OrbitalError } from '@orbital/types'
import { router, publicProcedure } from '../init.js'
// Round 7-01 — tenant-scoped project procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
import { tenantProcedure } from '../middleware/tenant.js'
import { installProcedure } from '../middleware/auth.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import type { ProjectsService } from '../../projects/service.js'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ConnectMondayInputSchema,
  ConnectGithubInputSchema,
  ResetProjectInputSchema,
  DeleteProjectInputSchema,
  ArchiveProjectInputSchema,
  ProjectMetadataInputSchema,
  PROJECTS_ERROR_CODES,
} from '../../projects/types.js'
import { optionalActiveProject } from '../../projects/active-project-context.js'
import type { MondayClient } from '../../backlog/monday-client.js'
import type { GithubClient } from '../../github/client.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const listInputSchema = z
  .object({
    /** undefined = active+archived; true = archived only; false = active only */
    archived: z.boolean().optional(),
  })
  .optional()

const getInputSchema = z.object({
  projectId: z.string().uuid(),
})

const archiveInputSchema = z.object({
  projectId: z.string().uuid(),
})

const testMondayInputSchema = z.object({
  boardId: z.string().min(1).max(64),
})

const testGithubInputSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
})

// ---------------------------------------------------------------------------
// Output mapping (Drizzle Date columns → ISO strings for client serialization)
// ---------------------------------------------------------------------------

export interface ProjectClientShape {
  projectId: string
  installId: string
  tenantId: string
  name: string
  slug: string
  description: string | null
  color: string | null
  mondayBoardId: string | null
  githubOwner: string | null
  githubRepo: string | null
  githubDefaultBranch: string
  repoUrl: string | null
  scmProvider: string
  ticketProvider: string
  archivedAt: string | null
  deletedAt: string | null
  createdByEventId: string | null
  createdAt: string
  updatedAt: string
  schemaVersion: number
}

interface ProjectRowLike {
  projectId: string
  installId: string
  tenantId?: string
  name: string
  slug: string
  description: string | null
  color?: string | null
  mondayBoardId: string | null
  githubOwner: string | null
  githubRepo: string | null
  githubDefaultBranch: string
  repoUrl?: string | null
  scmProvider?: string
  ticketProvider?: string
  archivedAt: Date | null
  deletedAt?: Date | null
  createdByEventId: string | null
  createdAt: Date
  updatedAt: Date
  schemaVersion: number
}

function toClient(row: ProjectRowLike): ProjectClientShape {
  return {
    projectId: row.projectId,
    installId: row.installId,
    tenantId: row.tenantId ?? '00000000-0000-0000-0000-000000000000',
    name: row.name,
    slug: row.slug,
    description: row.description,
    color: row.color ?? null,
    mondayBoardId: row.mondayBoardId,
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    githubDefaultBranch: row.githubDefaultBranch,
    repoUrl: row.repoUrl ?? null,
    scmProvider: row.scmProvider ?? 'internal',
    ticketProvider: row.ticketProvider ?? 'internal',
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdByEventId: row.createdByEventId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    schemaVersion: row.schemaVersion,
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapToTRPCError(err: unknown): never {
  if (err instanceof TRPCError) throw err
  if (err instanceof OrbitalError) {
    if (err.code === PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err })
    }
    if (
      err.code === PROJECTS_ERROR_CODES.CONFLICT_SLUG ||
      err.code === PROJECTS_ERROR_CODES.RESERVED_SLUG
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err })
    }
    if (err.code === PROJECTS_ERROR_CODES.FORBIDDEN) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err })
    }
    if (err.code === PROJECTS_ERROR_CODES.CONFIRM_MISMATCH) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err })
    }
    if (err.code === PROJECTS_ERROR_CODES.ACTIVE_PROJECT_REQUIRED) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err })
    }
    if (err.code === PROJECTS_ERROR_CODES.VALIDATION_ERROR) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err })
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    })
  }
  if (err instanceof Error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    })
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown error' })
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface ProjectsRouterDeps {
  projectsService: ProjectsService
  mondayClient: MondayClient | null
  githubClient: GithubClient | null
}

export function createProjectsRouter(deps: ProjectsRouterDeps) {
  const { projectsService, mondayClient, githubClient } = deps

  return router({
    // -----------------------------------------------------------------------
    // queries
    // -----------------------------------------------------------------------
    list: tenantProcedure.input(listInputSchema).query(async ({ input, ctx }) => {
      // Round 7-02 — hub proxy: project list is shared data.
      // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
      const hub = getHubClient()
      if (hub !== null) {
        const result = await hub.query<ProjectClientShape[]>('projects.list', input, ctx.tenantId)
        if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
        return result.data
      }

      try {
        const rows = await projectsService.list(input ?? {}, ctx.tenantId)
        return rows.map(toClient)
      } catch (err) {
        mapToTRPCError(err)
      }
    }),

    get: tenantProcedure.input(getInputSchema).query(async ({ input, ctx }) => {
      try {
        const row = await projectsService.get(input.projectId, ctx.tenantId)
        if (!row) return null
        return toClient(row)
      } catch (err) {
        mapToTRPCError(err)
      }
    }),

    getActive: tenantProcedure.query(async ({ ctx }) => {
      const id = optionalActiveProject(ctx)
      if (!id) return null
      try {
        const row = await projectsService.get(id, ctx.tenantId)
        return row ? toClient(row) : null
      } catch (err) {
        mapToTRPCError(err)
      }
    }),

    testMondayConnection: tenantProcedure
      .input(testMondayInputSchema)
      .query(async ({ input }) => {
        if (mondayClient === null) {
          return {
            ok: false,
            message:
              'Monday client not configured (set MONDAY_API_TOKEN or store under keychain account monday_api_token)',
          }
        }
        try {
          await mondayClient.getBoardItems(input.boardId)
          return { ok: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(
            { boardId: input.boardId, err: msg },
            'projects.testMondayConnection: failed',
          )
          return { ok: false, message: msg }
        }
      }),

    testGithubConnection: tenantProcedure
      .input(testGithubInputSchema)
      .query(async ({ input }) => {
        if (githubClient === null) {
          return {
            ok: false,
            message:
              'Github client not configured (set GITHUB_API_TOKEN or store under keychain account github.api_token)',
          }
        }
        try {
          const repo = await githubClient.getRepo(input.owner, input.repo)
          if (!repo) {
            return {
              ok: false,
              message: `Repo ${input.owner}/${input.repo} not found`,
            }
          }
          return {
            ok: true,
            defaultBranch: repo.defaultBranch,
            isPrivate: repo.private,
            htmlUrl: repo.htmlUrl,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(
            { owner: input.owner, repo: input.repo, err: msg },
            'projects.testGithubConnection: failed',
          )
          return { ok: false, message: msg }
        }
      }),

    // -----------------------------------------------------------------------
    // mutations
    // -----------------------------------------------------------------------
    create: tenantProcedure
      .input(CreateProjectInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const row = await projectsService.create(input, undefined, ctx.tenantId)
          return toClient(row)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    update: tenantProcedure
      .input(UpdateProjectInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const row = await projectsService.update(input, undefined, ctx.tenantId)
          return toClient(row)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    archive: tenantProcedure
      .input(
        z.union([
          archiveInputSchema, // legacy { projectId } shape
          ArchiveProjectInputSchema, // new { projectId, confirmName }
        ]),
      )
      .mutation(async ({ input, ctx }) => {
        try {
          // Normalise legacy { projectId } shape into ArchiveProjectInput by
          // using the projectId directly (legacy callers don't supply
          // confirmName). The service's union signature accepts a bare string
          // for backwards compatibility.
          if (!('confirmName' in input)) {
            await projectsService.archive(input.projectId, undefined, ctx.tenantId)
          } else {
            await projectsService.archive(input, undefined, ctx.tenantId)
          }
          return { ok: true as const }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    // -----------------------------------------------------------------------
    // /settings/general — General-tab procedures
    // [Engineer-Principal · Opus · run-settings-general]
    // -----------------------------------------------------------------------

    reset: tenantProcedure
      .input(ResetProjectInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const result = await projectsService.reset(input, undefined, ctx.tenantId)
          return { ok: true as const, cleared: result.cleared }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    delete: installProcedure
      .input(DeleteProjectInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const isAdmin = ctx.role === 'owner'
          await projectsService.delete(input, undefined, ctx.tenantId, { isAdmin })
          return { ok: true as const }
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    metadata: tenantProcedure
      .input(ProjectMetadataInputSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await projectsService.metadata(input.projectId, ctx.tenantId)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    connectMonday: tenantProcedure
      .input(ConnectMondayInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const row = await projectsService.connectMonday(input, undefined, ctx.tenantId)
          return toClient(row)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),

    connectGithub: tenantProcedure
      .input(ConnectGithubInputSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          const row = await projectsService.connectGithub(input, undefined, ctx.tenantId)
          return toClient(row)
        } catch (err) {
          mapToTRPCError(err)
        }
      }),
  })
}

export type ProjectsRouter = ReturnType<typeof createProjectsRouter>
