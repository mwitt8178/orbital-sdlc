/**
 * trpc/routers/planning.ts — LLM-backed vision decomposition router.
 *
 * Procedures:
 *   planning.history    (query)    — list past planning_runs for a vision
 *   planning.regenerate (mutation) — invoke Claude, return proposal (no commit)
 *   planning.commit     (mutation) — persist a proposal as epics/stories/ACs
 *
 * Tenant scoping: every query/mutation filters on ctx.tenantId.
 * OCC: commit retries up to 3 times on serialization_failure.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { uuidv7 } from 'uuidv7'
import { eq, and, desc } from 'drizzle-orm'
import { router, publicProcedure } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db } from '../../db/client.js'
import { planningRuns, visionDocuments, visionVersions } from '@orbital/db'
import { epics, stories, storyAcceptanceCriteria } from '@orbital/db'
import { createEventStore } from '../../events/store.js'
import { sql as sqlPool } from '../../db/client.js'
import { createAnthropicDriver } from '../../drivers/anthropic.js'
import {
  decomposeVisionWithLLM,
  ProposedDecompositionSchema,
  CostCapExceededError,
  LLMOutputInvalidError,
  type ProposedDecomposition,
} from '../../vision/llm-decomposer.js'
import { logger } from '../../config/logger.js'
// Round cost-guardrails — pre-flight budget check before each Claude call.
// [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
import { assertBudget, BudgetExceededError } from '@orbital/domain/cost/assert-budget.js'
// Estimated cost: claude-sonnet-4-6 at 10k input + 4k output (conservative for planning call).
// 10000/1M * $3.00 + 4000/1M * $15.00 = $0.030 + $0.060 = $0.090
const PLANNING_ESTIMATED_COST_USD = 0.090

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'

function tenantId(ctx: { tenantId?: string }): string {
  return ctx.tenantId ?? SENTINEL_TENANT
}

async function loadVisionContent(
  visionDocumentId: string,
): Promise<{ versionNumber: number; content: Record<string, unknown> } | null> {
  const docRows = await db
    .select()
    .from(visionDocuments)
    .where(eq(visionDocuments.visionDocumentId, visionDocumentId))
    .limit(1)
  const doc = docRows[0]
  if (!doc || !doc.currentVersionId) return null
  const verRows = await db
    .select()
    .from(visionVersions)
    .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
    .limit(1)
  const ver = verRows[0]
  if (!ver) return null
  return {
    versionNumber: ver.versionNumber,
    content: (ver.content ?? {}) as Record<string, unknown>,
  }
}

/** Detect Postgres serialization_failure (OCC). */
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
      logger.warn({ attempt: attempt + 1, backoff }, 'planning.commit: OCC retry')
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const HistoryInput = z.object({ visionId: z.string().uuid() })

const RegenerateInput = z.object({
  visionId:  z.string().uuid(),
  feedback:  z.string().max(2000).optional(),
  /** Active project ID — used for pre-flight budget enforcement. Optional for back-compat. */
  projectId: z.string().uuid().optional(),
})

const CommitInput = z.object({
  visionId: z.string().uuid(),
  runId: z.string().uuid(),
  proposal: ProposedDecompositionSchema,
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const planningRouter = router({
  /**
   * List past planning runs for a vision (tenant-scoped).
   * Most recent first.
   */
  history: tenantProcedure.input(HistoryInput).query(async ({ input, ctx }) => {
    const tid = tenantId(ctx)
    const rows = await db
      .select({
        runId: planningRuns.runId,
        visionVersion: planningRuns.visionVersion,
        startedAt: planningRuns.startedAt,
        endedAt: planningRuns.endedAt,
        inputTokens: planningRuns.inputTokens,
        outputTokens: planningRuns.outputTokens,
        usdCents: planningRuns.usdCents,
        exitStatus: planningRuns.exitStatus,
        committedAt: planningRuns.committedAt,
      })
      .from(planningRuns)
      .where(and(eq(planningRuns.tenantId, tid), eq(planningRuns.visionId, input.visionId)))
      .orderBy(desc(planningRuns.startedAt))
      .limit(50)
    return { items: rows }
  }),

  /**
   * Run Claude on the locked vision and return the proposal.
   * Persists a planning_runs row (committed_at = null) for audit.
   * Caller decides whether to commit via planning.commit.
   */
  regenerate: publicProcedure.input(RegenerateInput).mutation(async ({ input, ctx }) => {
    const tid = tenantId(ctx as { tenantId?: string })
    const runId = uuidv7()
    const startedAt = new Date()

    const vision = await loadVisionContent(input.visionId)
    if (!vision) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'vision document or version not found' })
    }

    // Pre-flight budget check — block if monthly hard cap would be exceeded.
    // [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
    if (input.projectId) {
      try {
        await assertBudget({
          tenantId:          tid,
          projectId:         input.projectId,
          persona:           'planner',
          estimatedCostUsd:  PLANNING_ESTIMATED_COST_USD,
          db,
        })
      } catch (budgetErr) {
        if (budgetErr instanceof BudgetExceededError) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Monthly budget exceeded: ${budgetErr.message}`,
          })
        }
        throw budgetErr
      }
    }

    // Pre-insert audit row so we capture aborted runs too.
    await db.insert(planningRuns).values({
      runId,
      tenantId: tid,
      visionId: input.visionId,
      visionVersion: vision.versionNumber,
      startedAt,
      exitStatus: 'pending',
    })

    try {
      const driver = createAnthropicDriver()
      const result = await decomposeVisionWithLLM({
        driver,
        content: vision.content,
        regenerationFeedback: input.feedback,
      })
      const endedAt = new Date()

      await db
        .update(planningRuns)
        .set({
          endedAt,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          usdCents: result.usdCents,
          exitStatus: 'completed',
          rawResponse: { proposal: result.proposal } as Record<string, unknown>,
        })
        .where(eq(planningRuns.runId, runId))

      return {
        runId,
        proposal: result.proposal,
        usage: result.usage,
        usdCents: result.usdCents,
      }
    } catch (err) {
      const endedAt = new Date()
      const status =
        err instanceof CostCapExceededError
          ? 'cost_capped'
          : err instanceof LLMOutputInvalidError
            ? 'invalid_output'
            : 'failed'
      await db
        .update(planningRuns)
        .set({
          endedAt,
          exitStatus: status,
        })
        .where(eq(planningRuns.runId, runId))
        .catch(() => {
          /* swallow — best-effort audit */
        })

      if (err instanceof CostCapExceededError) {
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: err.message,
        })
      }
      if (err instanceof TRPCError) throw err
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'llm_decompose_failed',
      })
    }
  }),

  /**
   * Persist a (possibly user-edited) proposal as epics + stories + ACs.
   * Wraps inserts in a single transaction with OCC retry.
   * Updates the matching planning_runs row with committed_at on success.
   */
  commit: publicProcedure.input(CommitInput).mutation(async ({ input, ctx }) => {
    const tid = tenantId(ctx as { tenantId?: string })

    const vision = await loadVisionContent(input.visionId)
    if (!vision) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'vision document or version not found' })
    }

    const proposal: ProposedDecomposition = input.proposal
    const docRows = await db
      .select({ currentVersionId: visionDocuments.currentVersionId })
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, input.visionId))
      .limit(1)
    const visionVersionId = docRows[0]?.currentVersionId
    if (!visionVersionId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'no current vision version' })
    }

    const epicIds: string[] = []
    const storyIds: string[] = []
    const acIds: string[] = []
    const autoMeta = {
      source: 'vision_lock' as const,
      vision_document_id: input.visionId,
      version: vision.versionNumber,
      planning_run_id: input.runId,
    }

    await withOccRetry(() =>
      db.transaction(async (tx) => {
        for (let epicIdx = 0; epicIdx < proposal.epics.length; epicIdx++) {
          const ep = proposal.epics[epicIdx]!
          const epicId = uuidv7()
          epicIds.push(epicId)
          await tx.insert(epics).values({
            epicId,
            tenantId: tid,
            visionVersionId,
            title: ep.title,
            rationale: ep.rationale,
            priority: epicIdx + 1,
            status: 'draft',
            autoGeneratedMetadata: autoMeta,
          })

          for (let storyIdx = 0; storyIdx < ep.stories.length; storyIdx++) {
            const st = ep.stories[storyIdx]!
            const storyId = uuidv7()
            storyIds.push(storyId)
            await tx.insert(stories).values({
              storyId,
              tenantId: tid,
              epicId,
              title: st.title,
              description: st.description,
              status: 'ready',
              storyPoints: st.story_points,
              priority: storyIdx + 1,
              autoGeneratedMetadata: autoMeta,
            })

            for (let acIdx = 0; acIdx < st.acceptance_criteria.length; acIdx++) {
              const acId = uuidv7()
              acIds.push(acId)
              await tx.insert(storyAcceptanceCriteria).values({
                acId,
                tenantId: tid,
                storyId,
                ordinal: acIdx + 1,
                text: st.acceptance_criteria[acIdx]!,
              })
            }
          }
        }
      }),
    )

    // Stamp the audit row.
    const committedAt = new Date()
    await db
      .update(planningRuns)
      .set({ committedAt, exitStatus: 'committed' })
      .where(and(eq(planningRuns.runId, input.runId), eq(planningRuns.tenantId, tid)))
      .catch(() => {
        /* best-effort */
      })

    // Emit summary events outside the transaction.
    try {
      const eventStore = createEventStore(db, sqlPool)
      const actor = { type: 'system' as const, component: 'orchestrator' as const }
      const occurredAt = committedAt.toISOString()
      for (const epicId of epicIds) {
        await eventStore.append({
          aggregate_id: epicId,
          aggregate_type: 'epic',
          event_type: 'EpicCreated',
          payload: {
            epic_id: epicId,
            vision_document_id: input.visionId,
            vision_version_id: visionVersionId,
            auto_generated: true,
            source: 'vision_lock_llm',
            planning_run_id: input.runId,
          },
          actor,
          trace_id: input.visionId,
          occurred_at: occurredAt,
          schema_version: 1,
        })
      }
      for (const storyId of storyIds) {
        await eventStore.append({
          aggregate_id: storyId,
          aggregate_type: 'story',
          event_type: 'StoryCreated',
          payload: {
            story_id: storyId,
            vision_document_id: input.visionId,
            auto_generated: true,
            source: 'vision_lock_llm',
            planning_run_id: input.runId,
          },
          actor,
          trace_id: input.visionId,
          occurred_at: occurredAt,
          schema_version: 1,
        })
      }
      await eventStore.append({
        aggregate_id: input.visionId,
        aggregate_type: 'vision_document',
        event_type: 'BacklogAutoDecomposed',
        payload: {
          vision_document_id: input.visionId,
          vision_version_id: visionVersionId,
          locked_version_number: vision.versionNumber,
          epic_count: epicIds.length,
          story_count: storyIds.length,
          epic_ids: epicIds,
          story_ids: storyIds,
          source: 'llm',
          planning_run_id: input.runId,
        },
        actor,
        trace_id: input.visionId,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    } catch (err) {
      logger.warn({ err, runId: input.runId }, 'planning.commit: event emission failed (non-fatal)')
    }

    return {
      runId: input.runId,
      epicIds,
      storyIds,
      acCount: acIds.length,
    }
  }),
})

export type PlanningRouter = typeof planningRouter
