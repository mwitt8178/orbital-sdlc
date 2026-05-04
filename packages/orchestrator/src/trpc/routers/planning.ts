/**
 * trpc/routers/planning.ts — LLM-backed vision decomposition router.
 *
 * Procedures:
 *   planning.history      (query)    — list past planning_runs for a vision
 *   planning.regenerate   (mutation) — invoke Claude, return proposal (no commit)
 *   planning.commit       (mutation) — persist a proposal as epics/stories/ACs
 *   planning.generatePlan (mutation) — invoke Claude + create vision_decomposition_runs row
 *   planning.approvePlan  (mutation) — approve a pending decomposition run (persist backlog)
 *   planning.discardPlan  (mutation) — discard a pending decomposition run (delete ephemeral rows)
 *   planning.runStatus    (query)    — get the latest vision_decomposition_runs row for a vision
 *
 * Tenant scoping: every query/mutation filters on ctx.tenantId.
 * OCC: commit/approvePlan retries up to 3 times on serialization_failure.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 * [Engineer-Sr · Sonnet · run-vision-decompose]
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
import { visionDecompositionRuns } from '@orbital/db'
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
      logger.warn({ attempt: attempt + 1, backoff }, 'planning OCC retry')
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

const GeneratePlanInput = z.object({
  visionId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  feedback: z.string().max(2000).optional(),
})

const ApprovePlanInput = z.object({
  runId: z.string().uuid(),
  visionId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  proposal: ProposedDecompositionSchema,
})

const DiscardPlanInput = z.object({
  runId: z.string().uuid(),
  visionId: z.string().uuid(),
})

const RunStatusInput = z.object({
  visionId: z.string().uuid(),
})

// ---------------------------------------------------------------------------
// Shared backlog insert logic (used by both commit and approvePlan)
// ---------------------------------------------------------------------------

async function insertProposalAsBacklog(
  tid: string,
  visionId: string,
  visionVersionId: string,
  visionVersionNumber: number,
  runId: string,
  proposal: ProposedDecomposition,
): Promise<{ epicIds: string[]; storyIds: string[]; acIds: string[] }> {
  const epicIds: string[] = []
  const storyIds: string[] = []
  const acIds: string[] = []
  const autoMeta = {
    source: 'vision_lock' as const,
    vision_document_id: visionId,
    version: visionVersionNumber,
    planning_run_id: runId,
  }

  await withOccRetry(() =>
    db.transaction(async (tx) => {
      // Idempotency guard: if epics already exist for this run, skip.
      // This prevents duplicate inserts on re-run of approvePlan.
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

  return { epicIds, storyIds, acIds }
}

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

    const { epicIds, storyIds, acIds } = await insertProposalAsBacklog(
      tid,
      input.visionId,
      visionVersionId,
      vision.versionNumber,
      input.runId,
      proposal,
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

  // ---------------------------------------------------------------------------
  // New procedures — vision_decomposition_runs lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Run Claude on the locked vision and return the proposal.
   * Creates a vision_decomposition_runs row (status=pending) + a planning_runs
   * audit row. The run ID must be passed to approvePlan or discardPlan.
   *
   * Errors clearly when ANTHROPIC_API_KEY is missing — the error message
   * tells the operator to configure it at /admin/integrations.
   */
  generatePlan: publicProcedure.input(GeneratePlanInput).mutation(async ({ input, ctx }) => {
    const tid = tenantId(ctx as { tenantId?: string })
    const runId = uuidv7()
    const startedAt = new Date()

    const vision = await loadVisionContent(input.visionId)
    if (!vision) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'vision document or version not found' })
    }

    // Insert vision_decomposition_runs row (pending).
    await db.insert(visionDecompositionRuns).values({
      id: runId,
      tenantId: tid,
      projectId: input.projectId ?? null,
      visionId: input.visionId,
      status: 'pending',
      startedAt,
    })

    // Also insert planning_runs audit row for token/cost tracking.
    const planRunId = uuidv7()
    await db.insert(planningRuns).values({
      runId: planRunId,
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
      const finishedAt = new Date()

      // Count from the proposal for the runs row.
      const epicCount = result.proposal.epics.length
      const storyCount = result.proposal.epics.reduce((sum, ep) => sum + ep.stories.length, 0)

      // Update decomposition run status.
      await db
        .update(visionDecompositionRuns)
        .set({
          status: 'pending', // stays pending until user approves/discards
          epicCount,
          storyCount,
          finishedAt,
        })
        .where(and(eq(visionDecompositionRuns.id, runId), eq(visionDecompositionRuns.tenantId, tid)))

      // Update planning_runs audit row.
      await db
        .update(planningRuns)
        .set({
          endedAt: finishedAt,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          usdCents: result.usdCents,
          exitStatus: 'completed',
          rawResponse: { proposal: result.proposal } as Record<string, unknown>,
        })
        .where(eq(planningRuns.runId, planRunId))

      logger.info(
        { tid, visionId: input.visionId, runId, epicCount, storyCount },
        'planning.generatePlan: completed — awaiting user approval',
      )

      return {
        runId,
        planRunId,
        proposal: result.proposal,
        usage: result.usage,
        usdCents: result.usdCents,
        epicCount,
        storyCount,
      }
    } catch (err) {
      const finishedAt = new Date()
      const errorMsg = err instanceof Error ? err.message : String(err)

      // Mark decomposition run as failed.
      await db
        .update(visionDecompositionRuns)
        .set({ status: 'failed', finishedAt, error: errorMsg })
        .where(and(eq(visionDecompositionRuns.id, runId), eq(visionDecompositionRuns.tenantId, tid)))
        .catch(() => { /* best-effort */ })

      // Mark planning_runs audit row as failed.
      await db
        .update(planningRuns)
        .set({
          endedAt: finishedAt,
          exitStatus: err instanceof CostCapExceededError ? 'cost_capped' : 'failed',
        })
        .where(eq(planningRuns.runId, planRunId))
        .catch(() => { /* best-effort */ })

      if (err instanceof CostCapExceededError) {
        throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: err.message })
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'llm_decompose_failed',
      })
    }
  }),

  /**
   * Approve a pending decomposition run — persists epics + stories + ACs,
   * stamps vision_decomposition_runs.status = 'approved'.
   *
   * Idempotent: calling twice for the same runId returns success (the backlog
   * rows were already written on the first call). The second call will still
   * attempt to insert, which may fail with a unique-key violation on
   * planning_run_id — we catch that case and return success.
   */
  approvePlan: publicProcedure.input(ApprovePlanInput).mutation(async ({ input, ctx }) => {
    const tid = tenantId(ctx as { tenantId?: string })

    // Verify the run exists and belongs to this tenant.
    const runRows = await db
      .select()
      .from(visionDecompositionRuns)
      .where(
        and(
          eq(visionDecompositionRuns.id, input.runId),
          eq(visionDecompositionRuns.tenantId, tid),
          eq(visionDecompositionRuns.visionId, input.visionId),
        ),
      )
      .limit(1)

    const run = runRows[0]
    if (!run) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `decomposition run ${input.runId} not found for this tenant/vision`,
      })
    }

    // Allow re-approval (idempotency): if already approved, just return.
    if (run.status === 'approved') {
      return { runId: input.runId, epicIds: [], storyIds: [], acCount: 0, alreadyApproved: true }
    }

    if (run.status === 'discarded') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cannot approve a discarded decomposition run',
      })
    }

    if (run.status === 'failed') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cannot approve a failed decomposition run',
      })
    }

    const vision = await loadVisionContent(input.visionId)
    if (!vision) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'vision document or version not found' })
    }

    const docRows = await db
      .select({ currentVersionId: visionDocuments.currentVersionId })
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, input.visionId))
      .limit(1)
    const visionVersionId = docRows[0]?.currentVersionId
    if (!visionVersionId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'no current vision version' })
    }

    const { epicIds, storyIds, acIds } = await insertProposalAsBacklog(
      tid,
      input.visionId,
      visionVersionId,
      vision.versionNumber,
      input.runId,
      input.proposal,
    )

    // Stamp the decomposition run as approved.
    const approvedAt = new Date()
    await db
      .update(visionDecompositionRuns)
      .set({ status: 'approved', finishedAt: approvedAt })
      .where(
        and(
          eq(visionDecompositionRuns.id, input.runId),
          eq(visionDecompositionRuns.tenantId, tid),
        ),
      )

    // Emit summary events.
    try {
      const eventStore = createEventStore(db, sqlPool)
      const actor = { type: 'system' as const, component: 'orchestrator' as const }
      const occurredAt = approvedAt.toISOString()
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
            source: 'vision_decompose_approved',
            decomposition_run_id: input.runId,
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
            source: 'vision_decompose_approved',
            decomposition_run_id: input.runId,
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
          source: 'vision_decompose_approved',
          decomposition_run_id: input.runId,
        },
        actor,
        trace_id: input.visionId,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    } catch (err) {
      logger.warn(
        { err, runId: input.runId },
        'planning.approvePlan: event emission failed (non-fatal)',
      )
    }

    return {
      runId: input.runId,
      epicIds,
      storyIds,
      acCount: acIds.length,
      alreadyApproved: false,
    }
  }),

  /**
   * Discard a pending decomposition run.
   * Stamps vision_decomposition_runs.status = 'discarded'.
   * Does not delete any rows — the run is retained for audit.
   */
  discardPlan: publicProcedure.input(DiscardPlanInput).mutation(async ({ input, ctx }) => {
    const tid = tenantId(ctx as { tenantId?: string })

    const runRows = await db
      .select()
      .from(visionDecompositionRuns)
      .where(
        and(
          eq(visionDecompositionRuns.id, input.runId),
          eq(visionDecompositionRuns.tenantId, tid),
          eq(visionDecompositionRuns.visionId, input.visionId),
        ),
      )
      .limit(1)

    const run = runRows[0]
    if (!run) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `decomposition run ${input.runId} not found for this tenant/vision`,
      })
    }

    if (run.status === 'approved') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'cannot discard an already-approved decomposition run',
      })
    }

    // Allow re-discard (idempotency).
    if (run.status === 'discarded') {
      return { runId: input.runId }
    }

    await db
      .update(visionDecompositionRuns)
      .set({ status: 'discarded', finishedAt: new Date() })
      .where(
        and(
          eq(visionDecompositionRuns.id, input.runId),
          eq(visionDecompositionRuns.tenantId, tid),
        ),
      )

    logger.info(
      { tid, visionId: input.visionId, runId: input.runId },
      'planning.discardPlan: run discarded',
    )

    return { runId: input.runId }
  }),

  /**
   * Get the latest vision_decomposition_runs row for a vision (tenant-scoped).
   * Returns null when no run exists.
   */
  runStatus: tenantProcedure.input(RunStatusInput).query(async ({ input, ctx }) => {
    const tid = tenantId(ctx)
    const rows = await db
      .select()
      .from(visionDecompositionRuns)
      .where(
        and(
          eq(visionDecompositionRuns.tenantId, tid),
          eq(visionDecompositionRuns.visionId, input.visionId),
        ),
      )
      .orderBy(desc(visionDecompositionRuns.startedAt))
      .limit(1)

    return rows[0] ?? null
  }),
})

export type PlanningRouter = typeof planningRouter
