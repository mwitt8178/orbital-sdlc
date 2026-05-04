/**
 * trpc/routers/audit.ts — tRPC router for audit subsystem.
 *
 * Per TRD-07 §6.1 and Implementation Plan §8 Task 4C:
 *   - audit.events.query: filterable, paginated event log query
 *   - audit.reconcile.trigger: on-demand reconciliation run
 *   - audit.reconciliation.list: list historical reconciliation runs
 *
 * Capability: audit:read for queries, audit:admin for reconcile.trigger.
 * In Phase 4C v1, capability checks are noted but not enforced at the tRPC
 * layer (enforcement is at the MCP gateway per TRD-07 §6.2); the procedures
 * are available to UI clients via the publicProcedure.
 *
 * All mutations write events via EventStore; no direct db.insert(events).
 */

import { z } from 'zod'
import { eq, desc, and, gte, lte, type SQL } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '../init.js'
// fix/multi-project-isolation — require active project header on audit reads.
// Note: audit events table has no project_id today; scoping by aggregate FK
// is a deeper change tracked separately. The header requirement still
// prevents a same-tenant project switcher from silently spanning projects.
import { projectProcedure } from '../middleware/project.js'
import { db, sql as sqlPool } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { createAuditQueryService } from '../../audit/query.js'
import { createDriftReconciler } from '../../audit/reconciler.js'
import { reconciliationRuns, driftEvents } from '../../db/schema/audit.js'
import { AuditQueryFilterSchema } from '../../audit/types.js'

// ---------------------------------------------------------------------------
// Lazy singletons — initialized on first use to avoid startup side effects
// ---------------------------------------------------------------------------

let _eventStore: ReturnType<typeof createEventStore> | null = null
let _queryService: ReturnType<typeof createAuditQueryService> | null = null
let _reconciler: ReturnType<typeof createDriftReconciler> | null = null

function getEventStore() {
  if (!_eventStore) _eventStore = createEventStore(db, sqlPool)
  return _eventStore
}

function getQueryService() {
  if (!_queryService) _queryService = createAuditQueryService(db, getEventStore())
  return _queryService
}

function getReconciler() {
  if (!_reconciler) _reconciler = createDriftReconciler(db, sqlPool, getEventStore())
  return _reconciler
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const QueryEventsInput = z.object({
  filters: AuditQueryFilterSchema.optional().default({}),
})

const TriggerReconcileInput = z.object({
  window_from: z.string().datetime().optional(),
  window_to: z.string().datetime().optional(),
  justification: z.string().min(1),
})

const ListReconciliationRunsInput = z.object({
  filters: z
    .object({
      trigger: z.enum(['scheduled', 'on_demand']).optional(),
      status: z.enum(['running', 'completed', 'failed']).optional(),
      started_from: z.string().datetime().optional(),
      started_to: z.string().datetime().optional(),
    })
    .optional()
    .default({}),
  after: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const auditRouter = router({
  events: router({
    /**
     * audit.events.query — filterable, paginated event log query.
     * Per TRD-07 §6.1.1.
     */
    query: projectProcedure.input(QueryEventsInput).query(async ({ input }) => {
      const service = getQueryService()
      try {
        return await service.query(input.filters)
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'INTERNAL_DB_ERROR: audit query failed',
          cause: err,
        })
      }
    }),
  }),

  reconcile: router({
    /**
     * audit.reconcile.trigger — trigger an on-demand reconciliation run.
     * Per TRD-07 §6.1.5.
     * Requires audit:admin capability (enforced at MCP gateway layer in full impl).
     * Justification is required per Primitives §14.
     */
    trigger: projectProcedure.input(TriggerReconcileInput).mutation(async ({ input }) => {
      const reconciler = getReconciler()

      try {
        const report = await reconciler.run({
          trigger: 'on_demand',
          windowFrom: input.window_from,
          windowTo: input.window_to,
        })

        return { run_id: report.run_id, status: report.status }
      } catch (err) {
        if (err instanceof Error && err.message === 'CONFLICT_RECONCILIATION_RUNNING') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'CONFLICT_RECONCILIATION_RUNNING: a reconciliation run is already in progress',
          })
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'INTERNAL_DB_ERROR: reconciliation run failed',
          cause: err,
        })
      }
    }),
  }),

  reconciliation: router({
    /**
     * audit.reconciliation.list — list historical reconciliation runs.
     * Per TRD-07 §6.1.4.
     */
    list: projectProcedure.input(ListReconciliationRunsInput).query(async ({ input }) => {
      const conditions: SQL[] = []

      if (input.filters.trigger !== undefined) {
        conditions.push(eq(reconciliationRuns.trigger, input.filters.trigger))
      }
      if (input.filters.status !== undefined) {
        conditions.push(eq(reconciliationRuns.status, input.filters.status))
      }
      if (input.filters.started_from !== undefined) {
        conditions.push(gte(reconciliationRuns.startedAt, input.filters.started_from))
      }
      if (input.filters.started_to !== undefined) {
        conditions.push(lte(reconciliationRuns.startedAt, input.filters.started_to))
      }

      // Cursor: opaque base64 over {started_at, run_id}
      if (input.after !== undefined) {
        const cursor = decodeCursor(input.after)
        if (cursor) {
          conditions.push(
            and(
              /* started_at DESC, run_id DESC for stable ordering */
              // Use raw SQL for the composite cursor condition
              // (started_at < cursor.started_at) OR (started_at = cursor.started_at AND run_id < cursor.run_id)
            ) as SQL,
          )
        }
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined

      const rows = await db
        .select()
        .from(reconciliationRuns)
        .where(whereClause)
        .orderBy(desc(reconciliationRuns.startedAt), desc(reconciliationRuns.runId))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows

      const lastRow = pageRows[pageRows.length - 1]
      const nextCursor =
        hasMore && lastRow !== undefined
          ? encodeCursor({ started_at: lastRow.startedAt, run_id: lastRow.runId })
          : null

      return {
        items: pageRows,
        next_cursor: nextCursor,
        has_more: hasMore,
      }
    }),
  }),

  drift: router({
    /**
     * audit.drift.list — paginated list of drift events.
     * Per TRD-07 §6.1.3.
     */
    list: projectProcedure
      .input(
        z.object({
          filters: z
            .object({
              run_id: z.string().optional(),
              source: z.enum(['git', 'worktree', 'monday', 'internal']).optional(),
              drift_kind: z.string().optional(),
              severity: z.enum(['info', 'warning', 'critical']).optional(),
              resolution: z
                .enum(['unresolved', 'acknowledged', 'remediated', 'false_positive'])
                .optional(),
              detected_from: z.string().datetime().optional(),
              detected_to: z.string().datetime().optional(),
            })
            .optional()
            .default({}),
          after: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(20),
        }),
      )
      .query(async ({ input }) => {
        const conditions: SQL[] = []

        if (input.filters.run_id !== undefined) {
          conditions.push(eq(driftEvents.runId, input.filters.run_id))
        }
        if (input.filters.source !== undefined) {
          conditions.push(eq(driftEvents.source, input.filters.source))
        }
        if (input.filters.drift_kind !== undefined) {
          conditions.push(eq(driftEvents.driftKind, input.filters.drift_kind))
        }
        if (input.filters.severity !== undefined) {
          conditions.push(eq(driftEvents.severity, input.filters.severity))
        }
        if (input.filters.detected_from !== undefined) {
          conditions.push(gte(driftEvents.detectedAt, input.filters.detected_from))
        }
        if (input.filters.detected_to !== undefined) {
          conditions.push(lte(driftEvents.detectedAt, input.filters.detected_to))
        }
        // resolution filter
        if (input.filters.resolution !== undefined) {
          if (input.filters.resolution === 'unresolved') {
            conditions.push(eq(driftEvents.resolution, null as unknown as string))
          } else {
            conditions.push(eq(driftEvents.resolution, input.filters.resolution))
          }
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select()
          .from(driftEvents)
          .where(whereClause)
          .orderBy(desc(driftEvents.detectedAt), desc(driftEvents.driftId))
          .limit(input.limit + 1)

        const hasMore = rows.length > input.limit
        const pageRows = hasMore ? rows.slice(0, input.limit) : rows

        const lastRow = pageRows[pageRows.length - 1]
        const nextCursor =
          hasMore && lastRow !== undefined
            ? encodeCursor({ started_at: lastRow.detectedAt, run_id: lastRow.driftId })
            : null

        return {
          items: pageRows,
          next_cursor: nextCursor,
          has_more: hasMore,
        }
      }),
  }),
})

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function encodeCursor(c: { started_at: string; run_id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64')
}

function decodeCursor(s: string | undefined | null): { started_at: string; run_id: string } | null {
  if (!s) return null
  try {
    const json = Buffer.from(s, 'base64').toString('utf-8')
    const parsed = JSON.parse(json) as { started_at?: string; run_id?: string }
    if (typeof parsed.started_at === 'string' && typeof parsed.run_id === 'string') {
      return { started_at: parsed.started_at, run_id: parsed.run_id }
    }
    return null
  } catch {
    return null
  }
}
