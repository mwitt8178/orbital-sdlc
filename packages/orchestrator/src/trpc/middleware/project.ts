/**
 * trpc/middleware/project.ts — Active-project resolution middleware.
 *
 * fix/multi-project-isolation — closes the cross-project bleed where every
 * tenant-scoped router relied solely on `tenant_id` and ignored
 * `x-orbital-project-id`.
 *
 * Behaviour:
 *   - Reads `x-orbital-project-id` from inbound headers (UI already sends it,
 *     see packages/ui/src/services/trpc.ts).
 *   - On mutate procedures and on procedures that read project-scoped
 *     aggregates, `requireProjectContext` throws BAD_REQUEST when the header
 *     is missing or malformed.
 *   - On read-only "list every project the tenant owns" procedures, prefer
 *     `optionalProjectContext` which leaves ctx.projectId = null.
 *
 * Pairing with tenantProcedure:
 *   tenantProcedure.use(getProjectMiddleware()).query(...)  // optional
 *   projectProcedure.query(...)                              // required
 *
 * The project_id is augmented into ctx so downstream queries can do:
 *   .where(and(
 *     eq(stories.tenantId, ctx.tenantId!),
 *     eq(stories.projectId, ctx.projectId!),
 *   ))
 *
 * SOC 2 controls: CC6.1 (logical access — tenant + project boundary),
 * CC6.6 (system-level controls preventing unauthorized access).
 *
 * [Security Review Agent · Opus · run-multi-project-isolation]
 */

import { TRPCError } from '@trpc/server'
import { middleware } from '../init.js'
import { tenantProcedure } from './tenant.js'

// ---------------------------------------------------------------------------
// Header & UUID validation
// ---------------------------------------------------------------------------

export const PROJECT_ID_HEADER = 'x-orbital-project-id'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readHeader(
  headers: Record<string, unknown> | undefined,
): string | null {
  if (!headers) return null
  const raw = headers[PROJECT_ID_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ---------------------------------------------------------------------------
// Required: throws if header missing or malformed.
// Use this for any procedure that touches project-scoped aggregates.
// ---------------------------------------------------------------------------

export const requireProjectContext = middleware(async ({ ctx, next }) => {
  const projectId = readHeader(ctx.req?.headers)
  if (projectId === null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `Missing required header '${PROJECT_ID_HEADER}'. ` +
        'Project-scoped procedures require an active project to be selected.',
    })
  }
  if (!UUID_RE.test(projectId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Header '${PROJECT_ID_HEADER}' must be a valid UUID.`,
    })
  }
  return next({
    ctx: {
      ...ctx,
      projectId,
    },
  })
})

// ---------------------------------------------------------------------------
// Optional: leaves ctx.projectId as string | null.
// Use only on procedures that legitimately span every project a tenant owns
// (e.g. projects.list itself).
// ---------------------------------------------------------------------------

export const optionalProjectContext = middleware(async ({ ctx, next }) => {
  const projectId = readHeader(ctx.req?.headers)
  if (projectId !== null && !UUID_RE.test(projectId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Header '${PROJECT_ID_HEADER}' must be a valid UUID.`,
    })
  }
  return next({
    ctx: {
      ...ctx,
      projectId,
    },
  })
})

// ---------------------------------------------------------------------------
// Procedure aliases — drop-in replacements for tenantProcedure.
// ---------------------------------------------------------------------------

/**
 * projectProcedure — tenant + required project. Use for every read/write
 * against a project-scoped aggregate (stories, epics, sprints, channels,
 * retros, uat sessions, tasks, etc.).
 */
export const projectProcedure = tenantProcedure.use(requireProjectContext)

/**
 * optionalProjectProcedure — tenant + optional project. Use only when the
 * procedure is genuinely project-agnostic within a tenant.
 */
export const optionalProjectProcedure = tenantProcedure.use(
  optionalProjectContext,
)

// ---------------------------------------------------------------------------
// Augmented context type — exported so router files can narrow ctx.projectId.
// ---------------------------------------------------------------------------

declare module '../init.js' {
  interface ReqContext {
    /**
     * Active project ID. Populated by requireProjectContext (always string)
     * or optionalProjectContext (string | null).
     * Undefined for tenantProcedure procedures that did not opt in.
     */
    projectId?: string | null
  }
}
