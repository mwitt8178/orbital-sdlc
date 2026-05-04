/**
 * trpc/routers/cost.ts — Cost governance tRPC router.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Procedures:
 *   cost.summary({projectId, sprintId?})        — aggregate cost + budget status
 *   cost.ledger({projectId, sprintId?, limit?}) — paginated cost_ledger rows
 *   cost.setBudget({scope, scopeId?, hardCapUsd, ...}) — upsert budget (admin-gated)
 *   cost.killAll({scope, scopeId, reason})       — SIGTERM all workers in scope (admin-gated)
 *
 * Auth: kill and setBudget require adminToken (same as admin.ts pattern).
 * summary and ledger are public (read-only cost data).
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, desc, lte } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { router, publicProcedure } from '../init.js'
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import { db, sql as sqlPool } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { costLedger, costEnforcementLog } from '../../db/schema/cost.js'
import { getCostService } from '../../cost/service.js'
import { getCostEnforcer } from '../../cost/enforcer.js'
import { authorizeAdminRequest } from '../../admin/auth.js'
import { loadEnv } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import type { BudgetPausedPayload } from '../../events/types.js'
import type { Actor } from '@orbital/types'
import {
  billingMonthSummary,
  billingDailySeries,
  billingByCategory,
  billingTopExpensive,
  billingProjection,
  billingExportCsv,
  billingUpdateBudget,
} from '@orbital/domain/cost/billing.js'
import { BILLING_CATEGORIES } from '@orbital/domain/cost/categories.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

let _eventStore: ReturnType<typeof createEventStore> | null = null
function getEventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sqlPool)
  return _eventStore
}

async function requireAdmin(token: string | undefined): Promise<void> {
  const env = loadEnv()
  const decision = await authorizeAdminRequest(token, env.NODE_ENV)
  if (!decision.allowed) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: decision.detail ?? `admin access denied (${decision.reasonCode})`,
    })
  }
}

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

const adminTokenSchema = z.string().optional()

const summaryInput = z.object({
  projectId: z.string().uuid(),
  sprintId:  z.string().uuid().optional(),
})

const summaryOutput = z.object({
  projectId:        z.string(),
  sprintId:         z.string().nullable(),
  totalCostUsd:     z.number(),
  todayCostUsd:     z.number(),
  hardCapUsd:       z.number().nullable(),
  softThresholdPct: z.number(),
  pctUsed:          z.number(),
  entryCount:       z.number(),
  windowStart:      z.string(),
  windowEnd:        z.string(),
})

const ledgerInput = z.object({
  projectId: z.string().uuid(),
  sprintId:  z.string().uuid().optional(),
  taskId:    z.string().uuid().optional(),
  limit:     z.number().int().min(1).max(500).default(100),
  cursor:    z.string().optional(),
})

const ledgerRowSchema = z.object({
  entryId:          z.string(),
  occurredAt:       z.string(),
  projectId:        z.string(),
  sprintId:         z.string().nullable(),
  taskId:           z.string().nullable(),
  workerId:         z.string().nullable(),
  personaId:        z.string().nullable(),
  model:            z.string(),
  provider:         z.string(),
  inputTokens:      z.number(),
  outputTokens:     z.number(),
  cacheReadTokens:  z.number(),
  cacheWriteTokens: z.number(),
  costUsd:          z.number(),
  requestId:        z.string().nullable(),
})

const ledgerOutput = z.object({
  rows:       z.array(ledgerRowSchema),
  nextCursor: z.string().nullable(),
})

const setBudgetInput = z.object({
  adminToken:       adminTokenSchema,
  scope:            z.enum(['install', 'project', 'sprint']),
  scopeId:          z.string().uuid().optional(),
  hardCapUsd:       z.number().positive(),
  softThresholdPct: z.number().int().min(1).max(100).default(80),
  onSoft:           z.enum(['alert', 'pause', 'none']).default('alert'),
  onHard:           z.enum(['pause', 'kill', 'alert_only']).default('pause'),
})

const setBudgetOutput = z.object({
  budgetId:         z.string(),
  scope:            z.string(),
  scopeId:          z.string().nullable(),
  hardCapUsd:       z.number(),
  softThresholdPct: z.number(),
  onSoft:           z.string(),
  onHard:           z.string(),
  active:           z.boolean(),
  createdAt:        z.string(),
})

const killAllInput = z.object({
  adminToken: adminTokenSchema,
  scope:      z.enum(['install', 'project', 'sprint']),
  scopeId:    z.string().uuid(),
  reason:     z.string().min(1).max(256),
})

const killAllOutput = z.object({
  killedWorkerIds: z.array(z.string()),
  signalsSent:     z.number(),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const costRouter = router({
  /**
   * Aggregate cost summary for a project (optionally scoped to a sprint).
   * Includes hard cap, pct used, and today's spend.
   */
  summary: projectProcedure
    .input(summaryInput)
    .output(summaryOutput)
    .query(async ({ input, ctx }) => {
      // fix/multi-project-isolation
      if (input.projectId !== ctx.projectId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'projectId mismatch between input and active project header',
        })
      }
      const svc = getCostService()
      const summary = await svc.summarize(input.projectId, input.sprintId ?? null)
      return summary
    }),

  /**
   * Paginated cost_ledger rows for a project/sprint/task.
   * Cursor is ISO timestamp of last row (occurred_at).
   */
  ledger: projectProcedure
    .input(ledgerInput)
    .output(ledgerOutput)
    .query(async ({ input, ctx }) => {
      // fix/multi-project-isolation
      if (input.projectId !== ctx.projectId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'projectId mismatch between input and active project header',
        })
      }
      const conditions = [eq(costLedger.projectId, input.projectId)]
      if (input.sprintId)  conditions.push(eq(costLedger.sprintId, input.sprintId))
      if (input.taskId)    conditions.push(eq(costLedger.taskId, input.taskId))
      if (input.cursor) {
        conditions.push(lte(costLedger.occurredAt, new Date(input.cursor)))
      }

      const rows = await db
        .select()
        .from(costLedger)
        .where(and(...conditions))
        .orderBy(desc(costLedger.occurredAt))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows
      const nextCursor = hasMore
        ? pageRows[pageRows.length - 1]?.occurredAt.toISOString() ?? null
        : null

      return {
        rows: pageRows.map((r) => ({
          entryId:          r.entryId,
          occurredAt:       r.occurredAt.toISOString(),
          projectId:        r.projectId,
          sprintId:         r.sprintId ?? null,
          taskId:           r.taskId ?? null,
          workerId:         r.workerId ?? null,
          personaId:        r.personaId ?? null,
          model:            r.model,
          provider:         r.provider,
          inputTokens:      r.inputTokens,
          outputTokens:     r.outputTokens,
          cacheReadTokens:  r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          costUsd:          Number(r.costUsd),
          requestId:        r.requestId ?? null,
        })),
        nextCursor,
      }
    }),

  /**
   * Upsert a cost budget. Deactivates prior budget for the same scope.
   * Capability-gated: requires adminToken.
   */
  setBudget: publicProcedure
    .input(setBudgetInput)
    .output(setBudgetOutput)
    .mutation(async ({ input }) => {
      await requireAdmin(input.adminToken)

      const svc = getCostService()
      const budget = await svc.setBudget({
        scope:            input.scope,
        scopeId:          input.scopeId ?? null,
        hardCapUsd:       input.hardCapUsd,
        softThresholdPct: input.softThresholdPct,
        onSoft:           input.onSoft,
        onHard:           input.onHard,
      })

      logger.info(
        { scope: input.scope, scopeId: input.scopeId, hardCapUsd: input.hardCapUsd },
        'cost.setBudget: budget upserted',
      )

      return {
        budgetId:         budget.budgetId,
        scope:            budget.scope,
        scopeId:          budget.scopeId,
        hardCapUsd:       budget.hardCapUsd,
        softThresholdPct: budget.softThresholdPct,
        onSoft:           budget.onSoft,
        onHard:           budget.onHard,
        active:           budget.active,
        createdAt:        budget.createdAt,
      }
    }),

  /**
   * Kill all workers in a scope. SIGTERM each; emits KillSwitchTripped per worker.
   * Capability-gated: requires adminToken.
   */
  killAll: publicProcedure
    .input(killAllInput)
    .output(killAllOutput)
    .mutation(async ({ input }) => {
      await requireAdmin(input.adminToken)

      const enforcer = getCostEnforcer()
      const result = await enforcer.killAll(
        input.scope,
        input.scopeId,
        input.reason,
        'operator',
      )

      // Emit BudgetPaused for scope.
      const eventStore = getEventStore()
      const payload: BudgetPausedPayload = {
        scope:     input.scope,
        scope_id:  input.scopeId,
        reason:    input.reason,
        paused_at: new Date().toISOString(),
      }
      try {
        await eventStore.append({
          aggregate_id:   input.scopeId,
          aggregate_type: 'sprint',
          event_type:     'BudgetPaused',
          payload:        payload as unknown as Record<string, unknown>,
          actor:          SYSTEM_ACTOR,
          trace_id:       uuidv7(),
          occurred_at:    payload.paused_at,
          schema_version: 1,
        })
      } catch (err) {
        logger.warn({ err }, 'cost.killAll: BudgetPaused emit failed (non-fatal)')
      }

      logger.info(
        { scope: input.scope, scopeId: input.scopeId, ...result },
        'cost.killAll: kill switch tripped',
      )

      return result
    }),

  /**
   * Paginated cost_enforcement_log rows for a project.
   * Used by the Billing page to show recent allow/block decisions.
   * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
   */
  enforcementLog: publicProcedure
    .input(z.object({
      projectId: z.string().uuid(),
      limit:     z.number().int().min(1).max(200).default(50),
      cursor:    z.string().optional(),
    }))
    .output(z.object({
      rows: z.array(z.object({
        id:                     z.string(),
        tenantId:               z.string(),
        projectId:              z.string(),
        persona:                z.string().nullable(),
        decision:               z.enum(['allow', 'block', 'throttle']),
        budgetCapUsd:           z.number().nullable(),
        mtdSpendUsd:            z.number(),
        wouldBeCostEstimateUsd: z.number(),
        reason:                 z.string().nullable(),
        createdAt:              z.string(),
      })),
      nextCursor: z.string().nullable(),
    }))
    .query(async ({ input }) => {
      const conditions = [eq(costEnforcementLog.projectId, input.projectId)]
      if (input.cursor) {
        conditions.push(lte(costEnforcementLog.createdAt, new Date(input.cursor)))
      }

      const rows = await db
        .select()
        .from(costEnforcementLog)
        .where(and(...conditions))
        .orderBy(desc(costEnforcementLog.createdAt))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows
      const nextCursor = hasMore
        ? pageRows[pageRows.length - 1]?.createdAt.toISOString() ?? null
        : null

      return {
        rows: pageRows.map((r) => ({
          id:                     r.id,
          tenantId:               r.tenantId,
          projectId:              r.projectId,
          persona:                r.persona ?? null,
          decision:               r.decision as 'allow' | 'block' | 'throttle',
          budgetCapUsd:           r.budgetCapUsd != null ? Number(r.budgetCapUsd) : null,
          mtdSpendUsd:            Number(r.mtdSpendUsd),
          wouldBeCostEstimateUsd: Number(r.wouldBeCostEstimateUsd),
          reason:                 r.reason ?? null,
          createdAt:              r.createdAt.toISOString(),
        })),
        nextCursor,
      }
    }),
})

// ---------------------------------------------------------------------------
// /settings/billing — read aggregations + budget patch + CSV export
// [Engineer-Principal · Opus · run-settings-billing]
// ---------------------------------------------------------------------------

const billingRangeInput = z.object({
  projectId: z.string().uuid(),
  fromDate:  z.string().datetime().optional(),
  toDate:    z.string().datetime().optional(),
})

const billingProjectIdInput = z.object({
  projectId: z.string().uuid(),
})

const billingUpdateInput = z.object({
  projectId: z.string().uuid(),
  patch: z.object({
    monthlyCapCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    hardStop:        z.boolean().optional(),
    digestEmails:    z.array(z.string().email()).max(20).optional(),
  }),
})

const billingExportInput = z.object({
  projectId: z.string().uuid(),
  fromDate:  z.string().datetime(),
  toDate:    z.string().datetime(),
})

function defaultMonthRange(input: { fromDate?: string; toDate?: string }): { from: Date; to: Date } {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return {
    from: input.fromDate ? new Date(input.fromDate) : start,
    to:   input.toDate   ? new Date(input.toDate)   : end,
  }
}

export const billingRouter = router({
  /**
   * Hero-level summary for the active month: total spend, monthly cap, %
   * used, hard-stop flag, digest subscribers, all-time total.
   */
  summary: publicProcedure
    .input(billingProjectIdInput)
    .query(async ({ input }) => {
      return billingMonthSummary(db, input.projectId)
    }),

  /**
   * Day-by-day spend (zero-filled) for the supplied range, default = active
   * UTC month. Used for the hero sparkline and the month chart.
   */
  dailySeries: publicProcedure
    .input(billingRangeInput)
    .query(async ({ input }) => {
      const { from, to } = defaultMonthRange(input)
      const series = await billingDailySeries(db, input.projectId, from, to)
      return { fromDate: from.toISOString(), toDate: to.toISOString(), series }
    }),

  /**
   * Spend split by billing category for the active month (or supplied range).
   * Powers the breakdown pie/stacked-bar.
   */
  byCategory: publicProcedure
    .input(billingRangeInput)
    .query(async ({ input }) => {
      const { from, to } = defaultMonthRange(input)
      const totals = await billingByCategory(db, input.projectId, from, to)
      return {
        fromDate: from.toISOString(),
        toDate:   to.toISOString(),
        categories: BILLING_CATEGORIES,
        totals,
      }
    }),

  /**
   * Top N most expensive stories (cost_ledger rows aggregated by task_id)
   * for the active month or supplied range.
   */
  topExpensive: publicProcedure
    .input(
      billingRangeInput.extend({ limit: z.number().int().min(1).max(50).default(10) }),
    )
    .query(async ({ input }) => {
      const { from, to } = defaultMonthRange(input)
      const rows = await billingTopExpensive(db, input.projectId, input.limit, from, to)
      return { rows }
    }),

  /**
   * Velocity-based projection for end-of-month spend.
   */
  projection: publicProcedure
    .input(billingProjectIdInput)
    .query(async ({ input }) => {
      return billingProjection(db, input.projectId)
    }),

  /**
   * CSV export of all cost_ledger rows for a project in a date range.
   * Returns a base64-encoded CSV that the UI converts to a Blob and downloads.
   */
  exportCsv: publicProcedure
    .input(billingExportInput)
    .mutation(async ({ input }) => {
      const from = new Date(input.fromDate)
      const to   = new Date(input.toDate)
      const { csv, rowCount, truncated } = await billingExportCsv(db, input.projectId, from, to)
      const csvBase64 = Buffer.from(csv, 'utf8').toString('base64')
      logger.info(
        { projectId: input.projectId, rowCount, truncated, fromDate: input.fromDate, toDate: input.toDate },
        'cost.exportCsv: generated',
      )
      return { csvBase64, rowCount, truncated, filename: `orbital-cost-${input.projectId.slice(0, 8)}-${input.fromDate.slice(0, 10)}.csv` }
    }),

  /**
   * Patch the project budget — monthly cap (in cents), hard-stop flag,
   * digest emails. Returns the updated month summary so the UI can refresh
   * in one round-trip.
   */
  updateBudget: publicProcedure
    .input(billingUpdateInput)
    .mutation(async ({ input }) => {
      const patch: {
        monthlyCapUsd?: number | null
        hardStop?: boolean
        digestEmails?: string[]
      } = {}

      if (input.patch.monthlyCapCents !== undefined) {
        patch.monthlyCapUsd =
          input.patch.monthlyCapCents == null ? null : input.patch.monthlyCapCents / 100
      }
      if (input.patch.hardStop !== undefined) patch.hardStop = input.patch.hardStop
      if (input.patch.digestEmails !== undefined) patch.digestEmails = input.patch.digestEmails

      const summary = await billingUpdateBudget(db, input.projectId, patch)
      logger.info(
        { projectId: input.projectId, patch },
        'cost.updateBudget: project budget patched',
      )
      return summary
    }),
})

export type BillingRouter = typeof billingRouter

export type CostRouter = typeof costRouter
