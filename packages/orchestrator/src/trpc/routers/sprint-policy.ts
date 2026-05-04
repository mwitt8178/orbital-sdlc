/**
 * trpc/routers/sprint-policy.ts — Per-project sprint policy router.
 *
 * [Engineer-Principal · Opus · run-settings-sprints]
 *
 * Procedures:
 *   sprintPolicy.get({ projectId })            — read policy (returns defaults if absent)
 *   sprintPolicy.update({ projectId, patch })  — partial update; OCC-retried
 *   sprintPolicy.reset({ projectId })          — overwrite with defaults
 *
 * Tenant scoping: every call checks `projects.tenantId === ctx.tenantId`
 * before touching the policy row. Cross-tenant access returns NOT_FOUND
 * (does not leak existence).
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and } from 'drizzle-orm'
import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db } from '../../db/client.js'
import { projects, projectSprintPolicy } from '@orbital/db'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CEREMONY_RULES = {
  planning: { enabled: true, dow: 1, hour: 9 },
  retro: { enabled: true, dow: 5, hour: 16 },
  auto_retro_on_complete: true,
  auto_create_next_sprint: true,
  auto_promote_ready_stories: false,
} as const

const DEFAULTS = {
  lengthWeeks: 2 as 1 | 2 | 3 | 4,
  startDow: 1,
  autoAdvance: false,
  pointsPerSprint: 20,
  budgetUsdCentsPerSprint: 0,
  budgetUsdCentsPerWeek: 0,
  ceremonyRules: DEFAULT_CEREMONY_RULES,
}

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const ceremonyRuleSlot = z.object({
  enabled: z.boolean(),
  dow: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
})

export const ceremonyRulesSchema = z.object({
  planning: ceremonyRuleSlot,
  retro: ceremonyRuleSlot,
  auto_retro_on_complete: z.boolean(),
  auto_create_next_sprint: z.boolean(),
  auto_promote_ready_stories: z.boolean(),
})

const policyShape = z.object({
  projectId: z.string().uuid(),
  lengthWeeks: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  startDow: z.number().int().min(0).max(6),
  autoAdvance: z.boolean(),
  pointsPerSprint: z.number().int().min(0).max(1000),
  budgetUsdCentsPerSprint: z.number().int().min(0),
  budgetUsdCentsPerWeek: z.number().int().min(0),
  ceremonyRules: ceremonyRulesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

const patchShape = z
  .object({
    lengthWeeks: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    startDow: z.number().int().min(0).max(6),
    autoAdvance: z.boolean(),
    pointsPerSprint: z.number().int().min(0).max(1000),
    budgetUsdCentsPerSprint: z.number().int().min(0),
    budgetUsdCentsPerWeek: z.number().int().min(0),
    ceremonyRules: ceremonyRulesSchema,
  })
  .partial()

// ---------------------------------------------------------------------------
// OCC retry
// ---------------------------------------------------------------------------

function isSerializationFailure(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code === '40001'
  }
  return false
}

async function withOccRetry<T>(fn: () => Promise<T>, max = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isSerializationFailure(err)) throw err
      const backoff = 50 * Math.pow(2, attempt) + Math.floor(Math.random() * 50)
      logger.warn(
        { attempt: attempt + 1, backoff },
        'sprintPolicy: OCC retry on serialization_failure',
      )
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'

function tenant(ctx: { tenantId?: string }): string {
  return ctx.tenantId ?? SENTINEL_TENANT
}

async function assertProjectInTenant(projectId: string, tenantId: string): Promise<void> {
  const rows = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))
    .limit(1)
  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found' })
  }
}

type Row = typeof projectSprintPolicy.$inferSelect

function rowToOutput(r: Row) {
  return {
    projectId: r.projectId,
    lengthWeeks: r.lengthWeeks as 1 | 2 | 3 | 4,
    startDow: r.startDow,
    autoAdvance: r.autoAdvance,
    pointsPerSprint: r.pointsPerSprint,
    budgetUsdCentsPerSprint: Number(r.budgetUsdCentsPerSprint),
    budgetUsdCentsPerWeek: Number(r.budgetUsdCentsPerWeek),
    ceremonyRules: ceremonyRulesSchema.parse(
      Object.keys((r.ceremonyRules ?? {}) as object).length === 0
        ? DEFAULT_CEREMONY_RULES
        : r.ceremonyRules,
    ),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function defaultsRow(projectId: string, tenantId: string): Row {
  const now = new Date()
  return {
    projectId,
    tenantId,
    lengthWeeks: DEFAULTS.lengthWeeks,
    startDow: DEFAULTS.startDow,
    autoAdvance: DEFAULTS.autoAdvance,
    pointsPerSprint: DEFAULTS.pointsPerSprint,
    budgetUsdCentsPerSprint: DEFAULTS.budgetUsdCentsPerSprint,
    budgetUsdCentsPerWeek: DEFAULTS.budgetUsdCentsPerWeek,
    ceremonyRules: DEFAULTS.ceremonyRules as unknown as Row['ceremonyRules'],
    createdAt: now,
    updatedAt: now,
  }
}

async function readOrSynthesise(projectId: string, tenantId: string): Promise<Row> {
  const rows = await db
    .select()
    .from(projectSprintPolicy)
    .where(eq(projectSprintPolicy.projectId, projectId))
    .limit(1)
  if (rows[0]) return rows[0]
  return defaultsRow(projectId, tenantId)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const sprintPolicyRouter = router({
  get: tenantProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .output(policyShape)
    .query(async ({ ctx, input }) => {
      const tenantId = tenant(ctx)
      await assertProjectInTenant(input.projectId, tenantId)
      const row = await readOrSynthesise(input.projectId, tenantId)
      return rowToOutput(row)
    }),

  update: tenantProcedure
    .input(z.object({ projectId: z.string().uuid(), patch: patchShape }))
    .output(policyShape)
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenant(ctx)
      await assertProjectInTenant(input.projectId, tenantId)

      const { patch } = input

      return await withOccRetry(async () => {
        const now = new Date()

        // Read existing or synthesise defaults, apply patch, then upsert.
        const existing = await readOrSynthesise(input.projectId, tenantId)
        const merged: Row = {
          ...existing,
          ...(patch.lengthWeeks !== undefined && { lengthWeeks: patch.lengthWeeks }),
          ...(patch.startDow !== undefined && { startDow: patch.startDow }),
          ...(patch.autoAdvance !== undefined && { autoAdvance: patch.autoAdvance }),
          ...(patch.pointsPerSprint !== undefined && { pointsPerSprint: patch.pointsPerSprint }),
          ...(patch.budgetUsdCentsPerSprint !== undefined && {
            budgetUsdCentsPerSprint: patch.budgetUsdCentsPerSprint,
          }),
          ...(patch.budgetUsdCentsPerWeek !== undefined && {
            budgetUsdCentsPerWeek: patch.budgetUsdCentsPerWeek,
          }),
          ...(patch.ceremonyRules !== undefined && {
            ceremonyRules: patch.ceremonyRules as unknown as Row['ceremonyRules'],
          }),
          tenantId,
          updatedAt: now,
        }

        await db
          .insert(projectSprintPolicy)
          .values(merged)
          .onConflictDoUpdate({
            target: projectSprintPolicy.projectId,
            set: {
              lengthWeeks: merged.lengthWeeks,
              startDow: merged.startDow,
              autoAdvance: merged.autoAdvance,
              pointsPerSprint: merged.pointsPerSprint,
              budgetUsdCentsPerSprint: merged.budgetUsdCentsPerSprint,
              budgetUsdCentsPerWeek: merged.budgetUsdCentsPerWeek,
              ceremonyRules: merged.ceremonyRules,
              tenantId: merged.tenantId,
              updatedAt: merged.updatedAt,
            },
          })

        const fresh = await readOrSynthesise(input.projectId, tenantId)
        return rowToOutput(fresh)
      })
    }),

  reset: tenantProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .output(policyShape)
    .mutation(async ({ ctx, input }) => {
      const tenantId = tenant(ctx)
      await assertProjectInTenant(input.projectId, tenantId)

      return await withOccRetry(async () => {
        const now = new Date()
        const fresh = defaultsRow(input.projectId, tenantId)
        fresh.updatedAt = now

        await db
          .insert(projectSprintPolicy)
          .values(fresh)
          .onConflictDoUpdate({
            target: projectSprintPolicy.projectId,
            set: {
              lengthWeeks: fresh.lengthWeeks,
              startDow: fresh.startDow,
              autoAdvance: fresh.autoAdvance,
              pointsPerSprint: fresh.pointsPerSprint,
              budgetUsdCentsPerSprint: fresh.budgetUsdCentsPerSprint,
              budgetUsdCentsPerWeek: fresh.budgetUsdCentsPerWeek,
              ceremonyRules: fresh.ceremonyRules,
              tenantId: fresh.tenantId,
              updatedAt: fresh.updatedAt,
            },
          })

        return rowToOutput(fresh)
      })
    }),
})
