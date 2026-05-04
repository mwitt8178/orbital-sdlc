/**
 * trpc/routers/project-personas.ts — per-project persona configuration.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * Procedures:
 *   projectPersonas.list({ projectId })            — baseline catalog merged with overrides
 *   projectPersonas.update({ projectId, slug, patch }) — upsert one row
 *   projectPersonas.reorder({ projectId, ordering })   — bulk-set ordering
 *   projectPersonas.costByPersona({ projectId, range }) — sum worker_runs grouped by persona
 *
 * Aggregates over (tenant_id, project_id, persona_slug). No FKs (DSQL).
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, eq, sql } from 'drizzle-orm'
import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db as dbClient } from '../../db/client.js'
import { projectPersonas, type ProjectPersonaRow } from '../../db/schema/project-personas.js'
import { BASELINE_PERSONAS } from '../../personas/library/index.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Allowed model identifiers (kept in lockstep with the UI dropdown)
// ---------------------------------------------------------------------------

const MODEL_IDS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const
const modelSchema = z.enum(MODEL_IDS)

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listInput = z.object({
  projectId: z.string().uuid(),
})

const updateInput = z.object({
  projectId: z.string().uuid(),
  personaSlug: z.string().min(1).max(64),
  patch: z
    .object({
      enabled: z.boolean().optional(),
      model: modelSchema.optional(),
      budgetUsdCents: z.number().int().min(0).max(100_00_000).optional(), // up to $100,000
      systemPromptOverride: z.string().max(50_000).nullable().optional(),
    })
    .strict(),
})

const reorderInput = z.object({
  projectId: z.string().uuid(),
  ordering: z.array(z.string().min(1).max(64)).min(1),
})

const costRangeSchema = z.enum(['week', 'month'])
const costInput = z.object({
  projectId: z.string().uuid(),
  range: costRangeSchema.default('week'),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface MergedPersona {
  slug: string
  displayName: string
  role: string
  blurb: string
  enabled: boolean
  model: (typeof MODEL_IDS)[number]
  budgetUsdCents: number
  systemPrompt: string
  systemPromptOverridden: boolean
  ordering: number
}

function deriveRole(slug: string): string {
  if (slug === 'pm' || slug === 'em' || slug === 'scrum-master') return 'Manager'
  if (slug === 'architect' || slug === 'principal-dev') return 'Architect'
  if (slug === 'sr-dev' || slug === 'jr-dev') return 'Engineer'
  if (slug === 'qa' || slug === 'verifier') return 'QA'
  if (slug === 'reviewer') return 'Reviewer'
  if (slug === 'security') return 'Security'
  if (slug === 'retro-analyst') return 'Analyst'
  return 'Persona'
}

function defaultModelForSlug(slug: string): (typeof MODEL_IDS)[number] {
  if (slug === 'principal-dev' || slug === 'architect' || slug === 'security') {
    return 'claude-opus-4-7'
  }
  if (slug === 'jr-dev' || slug === 'retro-analyst' || slug === 'verifier') {
    return 'claude-haiku-4-5'
  }
  return 'claude-sonnet-4-6'
}

function defaultBudgetForSlug(slug: string): number {
  // Higher-leverage roles get more budget headroom.
  if (slug === 'principal-dev' || slug === 'architect') return 1500 // $15
  if (slug === 'security') return 1000 // $10
  if (slug === 'jr-dev' || slug === 'retro-analyst') return 200 // $2
  return 500 // $5 default
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const projectPersonasRouter = router({
  /**
   * @route   projectPersonas.list
   * @summary List the persona roster for a project (baseline + overrides merged).
   * @access  Private (tenant-scoped)
   *
   * @returns Array<MergedPersona> ordered by `ordering` ascending, then slug.
   */
  list: tenantProcedure.input(listInput).query(async ({ input, ctx }): Promise<MergedPersona[]> => {
    const tenantId = ctx.tenantId ?? '00000000-0000-0000-0000-000000000000'
    const overrides = await dbClient
      .select()
      .from(projectPersonas)
      .where(
        and(
          eq(projectPersonas.tenantId, tenantId),
          eq(projectPersonas.projectId, input.projectId),
        ),
      )

    const overrideBySlug = new Map<string, ProjectPersonaRow>(
      (overrides as ProjectPersonaRow[]).map((o) => [o.personaSlug, o]),
    )

    const merged: MergedPersona[] = BASELINE_PERSONAS.map((p, idx) => {
      const o = overrideBySlug.get(p.slug)
      const role = deriveRole(p.slug)
      const baselinePrompt = p.roleBrief.bodyMd
      return {
        slug: p.slug,
        displayName: p.displayName,
        role,
        blurb: p.roleBrief.headline,
        enabled: o?.enabled ?? true,
        model: ((o?.model as (typeof MODEL_IDS)[number]) ?? defaultModelForSlug(p.slug)),
        budgetUsdCents: o?.budgetUsdCents ?? defaultBudgetForSlug(p.slug),
        systemPrompt: o?.systemPromptOverride ?? baselinePrompt,
        systemPromptOverridden: !!o?.systemPromptOverride,
        ordering: o?.ordering ?? (idx + 1) * 10,
      }
    })

    merged.sort((a, b) => a.ordering - b.ordering || a.slug.localeCompare(b.slug))
    return merged
  }),

  /**
   * @route   projectPersonas.update
   * @summary Upsert a single persona override row.
   * @access  Private (tenant-scoped)
   */
  update: tenantProcedure.input(updateInput).mutation(async ({ input, ctx }) => {
    const tenantId = ctx.tenantId ?? '00000000-0000-0000-0000-000000000000'

    const known = BASELINE_PERSONAS.some((p) => p.slug === input.personaSlug)
    if (!known) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Unknown persona slug: ${input.personaSlug}`,
      })
    }

    // Upsert with ON CONFLICT — Postgres-native.
    const enabled = input.patch.enabled
    const model = input.patch.model
    const budget = input.patch.budgetUsdCents
    const promptOverride =
      input.patch.systemPromptOverride === undefined ? undefined : input.patch.systemPromptOverride

    try {
      await dbClient
        .insert(projectPersonas)
        .values({
          tenantId,
          projectId: input.projectId,
          personaSlug: input.personaSlug,
          enabled: enabled ?? true,
          model: model ?? defaultModelForSlug(input.personaSlug),
          budgetUsdCents: budget ?? defaultBudgetForSlug(input.personaSlug),
          systemPromptOverride: promptOverride ?? null,
        })
        .onConflictDoUpdate({
          target: [projectPersonas.tenantId, projectPersonas.projectId, projectPersonas.personaSlug],
          set: {
            ...(enabled !== undefined ? { enabled } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(budget !== undefined ? { budgetUsdCents: budget } : {}),
            ...(promptOverride !== undefined
              ? { systemPromptOverride: promptOverride }
              : {}),
            updatedAt: sql`now()`,
          },
        })
    } catch (err) {
      logger.error({ err, input }, '[projectPersonas.update] upsert failed')
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to update persona configuration',
      })
    }

    return { ok: true as const, personaSlug: input.personaSlug }
  }),

  /**
   * @route   projectPersonas.reorder
   * @summary Set the ordering for the supplied list of persona slugs (10-step gaps).
   * @access  Private (tenant-scoped)
   */
  reorder: tenantProcedure.input(reorderInput).mutation(async ({ input, ctx }) => {
    const tenantId = ctx.tenantId ?? '00000000-0000-0000-0000-000000000000'

    // Validate every slug is a known baseline persona.
    for (const slug of input.ordering) {
      if (!BASELINE_PERSONAS.some((p) => p.slug === slug)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown persona slug: ${slug}` })
      }
    }

    // Sequential upserts — small list (≤ 11), well under the DSQL row limit.
    let i = 0
    for (const slug of input.ordering) {
      const ord = (i + 1) * 10
      i += 1
      await dbClient
        .insert(projectPersonas)
        .values({
          tenantId,
          projectId: input.projectId,
          personaSlug: slug,
          ordering: ord,
        })
        .onConflictDoUpdate({
          target: [projectPersonas.tenantId, projectPersonas.projectId, projectPersonas.personaSlug],
          set: { ordering: ord, updatedAt: sql`now()` },
        })
    }

    return { ok: true as const, count: input.ordering.length }
  }),

  /**
   * @route   projectPersonas.costByPersona
   * @summary Spend in USD cents grouped by persona, for the requested range.
   * @access  Private (tenant-scoped)
   *
   * Note: worker_runs records do not yet carry a persona_slug column. We
   * derive persona from the branch prefix when present (`feat/<slug>-...`),
   * else fall back to the catch-all bucket "_unattributed". This is a best-
   * effort rollup until the executor stamps persona_slug directly.
   */
  costByPersona: tenantProcedure
    .input(costInput)
    .query(async ({ input, ctx }): Promise<Array<{ personaSlug: string; usdCents: number }>> => {
      const tenantId = ctx.tenantId ?? '00000000-0000-0000-0000-000000000000'

      const since = new Date()
      if (input.range === 'week') {
        since.setUTCDate(since.getUTCDate() - 7)
      } else {
        since.setUTCMonth(since.getUTCMonth() - 1)
      }
      const sinceIso = since.toISOString()

      let rows: Array<{ branch: string | null; cost_usd_cents: number | null }> = []
      try {
        const result = await dbClient.execute<{
          branch: string | null
          cost_usd_cents: number | null
        }>(sql`
          SELECT branch, cost_usd_cents
          FROM worker_runs
          WHERE tenant_id = ${tenantId}
            AND started_at >= ${sinceIso}
          LIMIT 5000
        `)
        rows = Array.isArray(result)
          ? (result as unknown as typeof rows)
          : ((result as unknown as { rows?: typeof rows }).rows ?? [])
      } catch (err) {
        logger.debug({ err }, '[projectPersonas.costByPersona] worker_runs unavailable')
      }

      const buckets = new Map<string, number>()
      for (const r of rows) {
        const branch = r.branch ?? ''
        let slug = '_unattributed'
        // Match `feat/<slug>` or `<slug>/...` patterns.
        const m = branch.match(/^(?:feat|fix|chore)\/([a-z0-9-]+?)(?:[-/]|$)/i)
        const captured = m?.[1]
        if (captured && BASELINE_PERSONAS.some((p) => p.slug === captured)) {
          slug = captured
        }
        buckets.set(slug, (buckets.get(slug) ?? 0) + (r.cost_usd_cents ?? 0))
      }

      // Always include every baseline persona (with 0) so the UI can render a
      // complete table.
      for (const p of BASELINE_PERSONAS) {
        if (!buckets.has(p.slug)) buckets.set(p.slug, 0)
      }

      return Array.from(buckets.entries())
        .map(([personaSlug, usdCents]) => ({ personaSlug, usdCents }))
        .sort((a, b) => b.usdCents - a.usdCents)
    }),
})

export type ProjectPersonasRouter = typeof projectPersonasRouter

// Re-export public types for the UI.
export const ALLOWED_MODELS = MODEL_IDS
