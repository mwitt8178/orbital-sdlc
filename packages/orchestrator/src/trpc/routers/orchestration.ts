/**
 * trpc/routers/orchestration.ts — tRPC router for orchestration data.
 *
 * Per Implementation Plan §6 Task 2C exposes:
 *   - orchestration.tasks.list
 *   - orchestration.tasks.get
 *   - orchestration.workers.list
 *   - orchestration.escalations.list
 *
 * Pagination follows Primitives §12 (cursor-based, opaque base64 cursor).
 * No mutations — UI is read-only against the orchestration aggregate; mutations
 * happen via the MCP gateway from agent workers, or via the SprintService in
 * Phase 4B.
 *
 * Round 7-02 — hub proxy:
 *   tasks.list and tasks.get proxy to hub when ORBITAL_HUB_URL is set.
 *   workers.* / escalations.* stay local (process-scoped infrastructure).
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, desc, lt, inArray, type SQL } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { tasks, escalations } from '../../db/schema/orchestration.js'
import { agentWorkers } from '../../db/schema/worker-tables.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import { getWorkerOutputStream } from '../../orchestration/worker-output-stream.js'
import { router, publicProcedure } from '../init.js'
// Round 7-01 — tenant-scoped task procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
import { tenantProcedure } from '../middleware/tenant.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import { getInspectionService } from '../../inspection/service.js'

// ---------------------------------------------------------------------------
// Cursor helpers (opaque base64-encoded {created_at, id})
// ---------------------------------------------------------------------------

interface Cursor {
  created_at: string
  id: string
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64')
}

function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null
  try {
    const json = Buffer.from(s, 'base64').toString('utf-8')
    const parsed = JSON.parse(json) as { created_at?: string; id?: string }
    if (typeof parsed.created_at === 'string' && typeof parsed.id === 'string') {
      return { created_at: parsed.created_at, id: parsed.id }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Common pagination input
// ---------------------------------------------------------------------------

const PaginationInput = z.object({
  after: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
})

// ---------------------------------------------------------------------------
// orchestration router
// ---------------------------------------------------------------------------

export const orchestrationRouter = router({
  // ------------------------------------------------------------------------
  // tasks namespace
  // ------------------------------------------------------------------------
  tasks: router({
    list: projectProcedure
      .input(
        z
          .object({
            sprint_id: z.string().uuid().optional(),
            state: z
              .array(
                z.enum([
                  'pending',
                  'ready',
                  'in_progress',
                  'in_review',
                  'blocked',
                  'failed',
                  'escalated',
                  'done',
                ]),
              )
              .optional(),
          })
          .merge(PaginationInput),
      )
      .query(async ({ input, ctx }) => {
        // Round 7-02 — hub proxy: when hub configured, delegate to hub
        // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
        const hub = getHubClient()
        if (hub !== null) {
          const result = await hub.tasks.list(ctx.tenantId!, input.sprint_id)
          if (!result.ok) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
          }
          // Map HubTask (snake_case) → local Drizzle row shape (camelCase) so
          // UI code consuming this procedure always sees consistent field names.
          const items = result.data.map((t) => ({
            taskId: t.task_id,
            sprintId: t.sprint_id,
            title: t.title,
            description: t.description,
            state: t.state,
            ordering: t.ordering,
            personaId: t.persona_id,
            riskClass: t.risk_class,
            attemptCount: t.attempt_count,
            retryBudget: t.retry_budget,
            wallClockTimeoutMs: t.wall_clock_timeout_ms,
            tokenBudget: t.token_budget,
            declaredWritePaths: t.declared_write_paths,
            createdAt: new Date(t.created_at),
            updatedAt: new Date(t.updated_at),
            tenantId: t.tenant_id,
            // Fields not in HubTask — null for hub rows
            storyId: null,
            ticketId: null,
            linkedArtifacts: [],
            iterationCount: 0,
            lastDefectId: null,
            escalationCount: 0,
            githubPrNumber: null,
            githubPrUrl: null,
            githubPrMergedAt: null,
            githubHeadSha: null,
            githubPrState: null,
            codeReviewState: null,
            tokensConsumed: 0,
            parentTaskId: null,
            currentWorkerId: null,
            currentCapabilityId: null,
            currentRoutingDecisionId: null,
            currentWorktreeId: null,
            startedAt: null,
            completedAt: null,
            createdByEventId: t.task_id,
            estimatedDurationMs: null,
          }))
          return {
            items,
            next_cursor: null,
            has_more: false,
          }
        }

        const conditions: SQL[] = [
          // Round 7-01: tenant isolation on tasks
          eq(tasks.tenantId, ctx.tenantId!),
          // fix/multi-project-isolation — project scoping
          eq(tasks.projectId, ctx.projectId!),
        ]
        if (input.sprint_id) conditions.push(eq(tasks.sprintId, input.sprint_id))
        if (input.state && input.state.length > 0) {
          conditions.push(inArray(tasks.state, input.state))
        }
        const cursor = decodeCursor(input.after)
        if (cursor) {
          // Cursor pagination by createdAt DESC, taskId DESC.
          conditions.push(lt(tasks.createdAt, new Date(cursor.created_at)))
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(desc(tasks.createdAt), desc(tasks.taskId))
          .limit(input.limit + 1)

        const hasMore = rows.length > input.limit
        const items = hasMore ? rows.slice(0, input.limit) : rows
        const last = items[items.length - 1]
        const nextCursor =
          hasMore && last
            ? encodeCursor({ created_at: last.createdAt.toISOString(), id: last.taskId })
            : null

        return {
          items,
          next_cursor: nextCursor,
          has_more: hasMore,
        }
      }),

    get: projectProcedure
      .input(z.object({ task_id: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        // Round 7-02 — hub proxy
        // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
        const hub = getHubClient()
        if (hub !== null) {
          const result = await hub.tasks.get(ctx.tenantId!, input.task_id)
          if (!result.ok) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
          }
          if (!result.data) return null
          const t = result.data
          // Map HubTask → local Drizzle row shape (camelCase)
          return {
            taskId: t.task_id,
            sprintId: t.sprint_id,
            title: t.title,
            description: t.description,
            state: t.state,
            ordering: t.ordering,
            personaId: t.persona_id,
            riskClass: t.risk_class,
            attemptCount: t.attempt_count,
            retryBudget: t.retry_budget,
            wallClockTimeoutMs: t.wall_clock_timeout_ms,
            tokenBudget: t.token_budget,
            declaredWritePaths: t.declared_write_paths,
            createdAt: new Date(t.created_at),
            updatedAt: new Date(t.updated_at),
            tenantId: t.tenant_id,
            storyId: null, ticketId: null, linkedArtifacts: [], iterationCount: 0,
            lastDefectId: null, escalationCount: 0, githubPrNumber: null,
            githubPrUrl: null, githubPrMergedAt: null, githubHeadSha: null,
            githubPrState: null, codeReviewState: null, tokensConsumed: 0,
            parentTaskId: null, currentWorkerId: null, currentCapabilityId: null,
            currentRoutingDecisionId: null, currentWorktreeId: null,
            startedAt: null, completedAt: null, createdByEventId: t.task_id,
            estimatedDurationMs: null,
          }
        }

        const rows = await db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.taskId, input.task_id),
              eq(tasks.tenantId, ctx.tenantId!),
              // fix/multi-project-isolation
              eq(tasks.projectId, ctx.projectId!),
            ),
          )
          .limit(1)
        return rows[0] ?? null
      }),

    /**
     * Round 5D: returns PR status for a task.
     * Returns null when no PR has been opened for this task.
     */
    prStatus: projectProcedure
      .input(z.object({ task_id: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        const rows = await db
          .select({
            pr_number: tasks.githubPrNumber,
            pr_url: tasks.githubPrUrl,
            merged_at: tasks.githubPrMergedAt,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.taskId, input.task_id),
              eq(tasks.tenantId, ctx.tenantId!),
              // fix/multi-project-isolation
              eq(tasks.projectId, ctx.projectId!),
            ),
          )
          .limit(1)
        const row = rows[0]
        if (!row || row.pr_number === null || row.pr_number === undefined) return null
        return {
          pr_number: row.pr_number,
          pr_url: row.pr_url ?? null,
          merged_at: row.merged_at ? row.merged_at.toISOString() : null,
          // State derived from merged_at: if merged → 'merged', else → 'open'
          state: row.merged_at ? 'merged' : 'open',
        }
      }),
  }),

  // ------------------------------------------------------------------------
  // workers namespace
  // ------------------------------------------------------------------------
  workers: router({
    list: tenantProcedure
      .input(
        z
          .object({
            status: z
              .array(
                z.enum(['connecting', 'active', 'idle', 'terminating', 'terminated']),
              )
              .optional(),
            task_id: z.string().uuid().optional(),
          })
          .merge(PaginationInput),
      )
      .query(async ({ input, ctx }) => {
        // agent_workers has no tenant_id column — it is process-scoped infrastructure.
        // Callers must supply task_id to scope results to a specific tenant's work.
        // Full tenant scoping requires a schema migration (deferred per round-7-01 scope).
        // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
        void ctx.tenantId
        const conditions: SQL[] = []
        if (input.status && input.status.length > 0) {
          conditions.push(inArray(agentWorkers.status, input.status))
        }
        if (input.task_id) conditions.push(eq(agentWorkers.taskId, input.task_id))

        const cursor = decodeCursor(input.after)
        if (cursor) {
          conditions.push(lt(agentWorkers.startedAt, new Date(cursor.created_at)))
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select()
          .from(agentWorkers)
          .where(where)
          .orderBy(desc(agentWorkers.startedAt), desc(agentWorkers.workerId))
          .limit(input.limit + 1)

        const hasMore = rows.length > input.limit
        const items = hasMore ? rows.slice(0, input.limit) : rows
        const last = items[items.length - 1]
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                created_at: last.startedAt.toISOString(),
                id: last.workerId,
              })
            : null

        return {
          items,
          next_cursor: nextCursor,
          has_more: hasMore,
        }
      }),

    /**
     * orchestration.workers.getRecentOutput
     *
     * Round5B — return the last N stdout/stderr lines for a worker so the
     * dashboard's AgentLiveOutput drawer can backfill on open. The buffer is
     * held in process memory by the WorkerOutputStream registry and cleared
     * 30 seconds after the child exits, so this is a snapshot of the
     * currently-running worker's tail.
     *
     * If the worker_id is unknown (terminated, GC'd, or never registered)
     * this returns an empty array rather than 404 — the UI treats that as
     * "no live output yet".
     */
    getRecentOutput: tenantProcedure
      .input(
        z.object({
          worker_id: z.string().uuid(),
          limit: z.number().int().min(1).max(500).default(200),
        }),
      )
      .query(({ input }) => {
        const stream = getWorkerOutputStream(input.worker_id)
        if (!stream) {
          return {
            worker_id: input.worker_id,
            items: [] as Array<{
              line_seq: number
              worker_id: string
              task_id: string
              stream: 'stdout' | 'stderr'
              line: string
              occurred_at: string
            }>,
            available: false,
          }
        }
        const items = stream.getRecentLines(input.limit)
        return {
          worker_id: input.worker_id,
          items,
          available: true,
        }
      }),

    /**
     * orchestration.workers.inspect
     *
     * Round 6 #10 — Return the live inspection snapshot for a worker.
     * Reads from the in-memory InspectionService cache (no DB query).
     *
     * Returns null when the worker is unknown.
     *
     * [Engineer-Sr · Sonnet · run-round6-10-inspection]
     */
    inspect: tenantProcedure
      .input(z.object({ worker_id: z.string().uuid() }))
      .query(({ input }) => {
        const svc = getInspectionService()
        if (!svc) return null
        return svc.inspect(input.worker_id)
      }),

    /**
     * orchestration.workers.timeline
     *
     * Round 6 #10 — Return the timeline of inspection events for a worker
     * since a given ISO timestamp. Returns [] when unknown.
     *
     * [Engineer-Sr · Sonnet · run-round6-10-inspection]
     */
    timeline: tenantProcedure
      .input(
        z.object({
          worker_id: z.string().uuid(),
          since: z.string().datetime().optional(),
        }),
      )
      .query(({ input }) => {
        const svc = getInspectionService()
        if (!svc) return []
        const since = input.since ?? new Date(0).toISOString()
        return svc.timeline(input.worker_id, since)
      }),
  }),

  // ------------------------------------------------------------------------
  // escalations namespace
  // ------------------------------------------------------------------------
  escalations: router({
    list: projectProcedure
      .input(
        z
          .object({
            state: z
              .array(z.enum(['open', 'acknowledged', 'resolved', 'cancelled']))
              .optional(),
            task_id: z.string().uuid().optional(),
          })
          .merge(PaginationInput),
      )
      .query(async ({ input, ctx }) => {
        // escalations has no tenant_id — scope via tasks.tenant_id JOIN.
        // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
        const conditions: SQL[] = [
          eq(tasks.tenantId, ctx.tenantId!),
          // fix/multi-project-isolation — restrict via parent task projectId
          eq(tasks.projectId, ctx.projectId!),
        ]
        if (input.state && input.state.length > 0) {
          conditions.push(inArray(escalations.state, input.state))
        }
        if (input.task_id) conditions.push(eq(escalations.taskId, input.task_id))

        const cursor = decodeCursor(input.after)
        if (cursor) {
          conditions.push(lt(escalations.createdAt, new Date(cursor.created_at)))
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select({
            escalationId: escalations.escalationId,
            taskId: escalations.taskId,
            reason: escalations.reason,
            triggeringEventId: escalations.triggeringEventId,
            context: escalations.context,
            state: escalations.state,
            resolvedAt: escalations.resolvedAt,
            resolutionNote: escalations.resolutionNote,
            createdAt: escalations.createdAt,
          })
          .from(escalations)
          .innerJoin(tasks, eq(escalations.taskId, tasks.taskId))
          .where(where)
          .orderBy(desc(escalations.createdAt), desc(escalations.escalationId))
          .limit(input.limit + 1)

        const hasMore = rows.length > input.limit
        const items = hasMore ? rows.slice(0, input.limit) : rows
        const last = items[items.length - 1]
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                created_at: last.createdAt.toISOString(),
                id: last.escalationId,
              })
            : null

        return {
          items,
          next_cursor: nextCursor,
          has_more: hasMore,
        }
      }),
  }),
})

export type OrchestrationRouter = typeof orchestrationRouter
