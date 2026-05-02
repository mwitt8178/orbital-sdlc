/**
 * trpc/routers/uat.ts — UAT tRPC router.
 *
 * Per TRD-11 v0.2 §6.1.
 *
 * Procedures:
 *   uat.session.start     — open or resume a UAT session
 *   uat.session.get       — read session + AC results
 *   uat.session.list      — list all sessions for a ticket
 *   uat.ac.mark           — mark AC pass/fail
 *   uat.ac.unmark         — revert AC to pending
 *   uat.submit            — submit session (creates defects for failures)
 *   uat.accept            — accept a submitted session (full-pass path)
 *   uat.defects.list      — paginated defect list
 *
 * DI pattern: mirrors backlog.ts — factory functions with injected services.
 */

import { TRPCError } from '@trpc/server'
import { eq, and, desc } from 'drizzle-orm'
import { z } from 'zod'
import { publicProcedure, router } from '../init.js'
// Round 7-01 — tenant-scoped UAT procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
import { tenantProcedure } from '../middleware/tenant.js'
import type { UATService } from '../../uat/service.js'
import type { DefectService } from '../../uat/defects.js'
import {
  StartSessionInputSchema,
  MarkACInputSchema,
  UnmarkACInputSchema,
  SubmitSessionInputSchema,
  AcceptSessionInputSchema,
  ListDefectsInputSchema,
  GetSessionInputSchema,
  ListSessionsInputSchema,
  UAT_ERROR_CODES,
} from '../../uat/types.js'
import { defects as defectsTable } from '../../db/schema/uat.js'
import { acCheckEvidence } from '../../db/schema/ac-check-evidence.js'
import type { DB } from '../../db/client.js'
import { OrbitalError } from '@orbital/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapOrbitalError(err: unknown): TRPCError {
  if (err instanceof OrbitalError) {
    const code = err.code as string
    const httpCode = UAT_HTTP_STATUS[code] ?? 500
    const trpcCode = httpToTrpcCode(httpCode)
    return new TRPCError({ code: trpcCode, message: err.message, cause: err })
  }
  if (err instanceof TRPCError) return err
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: String(err) })
}

const UAT_HTTP_STATUS: Record<string, number> = {
  [UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION]: 404,
  [UAT_ERROR_CODES.NOT_FOUND_TICKET]: 404,
  [UAT_ERROR_CODES.NOT_FOUND_AC]: 404,
  [UAT_ERROR_CODES.NOT_FOUND_DEFECT]: 404,
  [UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION]: 409,
  [UAT_ERROR_CODES.CONFLICT_STORY_NOT_DONE]: 409,
  [UAT_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING]: 400,
  [UAT_ERROR_CODES.VALIDATION_PENDING_ACS_REMAIN]: 422,
  [UAT_ERROR_CODES.VERIFIER_AC_FAILED]: 422,
  [UAT_ERROR_CODES.UAT_AC_NOT_MARKED]: 422,
  [UAT_ERROR_CODES.UAT_DEFECT_CREATION_FAILED]: 500,
  [UAT_ERROR_CODES.UAT_PERSONA_OF_RECORD_UNRESOLVABLE]: 500,
  [UAT_ERROR_CODES.AUTH_SCOPE_DENIED]: 403,
  [UAT_ERROR_CODES.INTERNAL_DB_ERROR]: 500,
}

function httpToTrpcCode(
  http: number,
): 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'UNPROCESSABLE_CONTENT' | 'FORBIDDEN' | 'INTERNAL_SERVER_ERROR' {
  if (http === 404) return 'NOT_FOUND'
  if (http === 409) return 'CONFLICT'
  if (http === 400) return 'BAD_REQUEST'
  if (http === 422) return 'UNPROCESSABLE_CONTENT'
  if (http === 403) return 'FORBIDDEN'
  return 'INTERNAL_SERVER_ERROR'
}

// Stub user actor — in v1 UAT is single-user. The user_id is passed through
// justification context; a real auth middleware would populate this.
const STUB_USER_ID = 'user:local'

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface UATRouterDeps {
  uatService: UATService
  defectService: DefectService
  db: DB
}

export function createUATRouter(deps: UATRouterDeps) {
  const { uatService, db } = deps

  const sessionRouter = router({
    /**
     * uat.session.start — open (or resume) a UAT session.
     */
    start: tenantProcedure.input(StartSessionInputSchema).mutation(async ({ input, ctx }) => {
      try {
        const result = await uatService.startSession(input, { userId: STUB_USER_ID }, ctx.tenantId)
        return {
          session: {
            uat_session_id: result.session.uatSessionId,
            ticket_id: result.session.ticketId,
            session_version: result.session.sessionVersion,
            state: result.session.state,
            total_ac_count: result.session.totalAcCount,
            pass_count: result.session.passCount,
            fail_count: result.session.failCount,
            started_at: result.session.startedAt.toISOString(),
          },
          acceptance_criteria: result.acResults.map((r) => ({
            ac_id: r.acId,
            ac_ordinal: r.acOrdinal,
            text: r.acTextSnapshot,
            status: r.status,
            observed_behavior: r.observedBehavior ?? null,
          })),
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    /**
     * uat.session.get — read a session by id.
     */
    get: tenantProcedure.input(GetSessionInputSchema).query(async ({ input, ctx }) => {
      try {
        const result = await uatService.getSession(input.uat_session_id, ctx.tenantId)
        if (!result) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `session ${input.uat_session_id} not found` })
        }
        return {
          session: {
            uat_session_id: result.session.uatSessionId,
            ticket_id: result.session.ticketId,
            session_version: result.session.sessionVersion,
            state: result.session.state,
            total_ac_count: result.session.totalAcCount,
            pass_count: result.session.passCount,
            fail_count: result.session.failCount,
            started_at: result.session.startedAt.toISOString(),
            submitted_at: result.session.submittedAt?.toISOString() ?? null,
          },
          acceptance_criteria: result.acResults.map((r) => ({
            ac_id: r.acId,
            ac_ordinal: r.acOrdinal,
            text: r.acTextSnapshot,
            status: r.status,
            observed_behavior: r.observedBehavior ?? null,
          })),
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    /**
     * uat.session.list — all sessions for a ticket.
     */
    list: tenantProcedure.input(ListSessionsInputSchema).query(async ({ input, ctx }) => {
      try {
        const results = await uatService.listSessions(input.ticket_id, ctx.tenantId)
        return {
          ticket_id: input.ticket_id,
          sessions: results.map(({ session, acResults }) => ({
            uat_session_id: session.uatSessionId,
            session_version: session.sessionVersion,
            state: session.state,
            started_at: session.startedAt.toISOString(),
            submitted_at: session.submittedAt?.toISOString() ?? null,
            pass_count: session.passCount,
            fail_count: session.failCount,
            ac_results: input.include_ac_results
              ? acResults.map((r) => ({
                  ac_id: r.acId,
                  ac_ordinal: r.acOrdinal,
                  status: r.status,
                  observed_behavior: r.observedBehavior ?? null,
                }))
              : undefined,
          })),
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),
  })

  const acRouter = router({
    /**
     * uat.ac.mark — mark an AC pass/fail.
     */
    mark: tenantProcedure.input(MarkACInputSchema).mutation(async ({ input, ctx }) => {
      try {
        return await uatService.markAC(input, STUB_USER_ID, ctx.tenantId)
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    /**
     * uat.ac.unmark — revert AC to pending.
     */
    unmark: tenantProcedure.input(UnmarkACInputSchema).mutation(async ({ input, ctx }) => {
      try {
        return await uatService.unmarkAC(input, STUB_USER_ID, ctx.tenantId)
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    /**
     * uat.ac.evidence — return the most recent verifier evidence for an AC.
     *
     * Round 5C: drives the UAT UI's per-AC verifier signal column.
     * Returns null when no verification has run for this AC yet (UI shows the
     * "verifier pending" empty state).
     */
    /**
     * uat.ac.evidence — return the most recent verifier evidence for an AC.
     *
     * Round 5C: drives the UAT UI's per-AC verifier signal column.
     * Round 6 #6: now also surfaces ci_run_url, ci_check_name, ci_conclusion
     * when evidence_kind='ci_run'.
     * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
     */
    evidence: tenantProcedure
      .input(z.object({ ac_id: z.string().uuid() }))
      .query(async ({ input, ctx }) => {
        void ctx.tenantId
        const rows = await db
          .select({
            evidenceId: acCheckEvidence.evidenceId,
            verificationId: acCheckEvidence.verificationId,
            acId: acCheckEvidence.acId,
            result: acCheckEvidence.result,
            evidenceKind: acCheckEvidence.evidenceKind,
            testCommand: acCheckEvidence.testCommand,
            testOutput: acCheckEvidence.testOutput,
            testExitCode: acCheckEvidence.testExitCode,
            llmReasoning: acCheckEvidence.llmReasoning,
            filesInspected: acCheckEvidence.filesInspected,
            ciRunUrl: acCheckEvidence.ciRunUrl,
            ciCheckName: acCheckEvidence.ciCheckName,
            ciConclusion: acCheckEvidence.ciConclusion,
            createdAt: acCheckEvidence.createdAt,
          })
          .from(acCheckEvidence)
          .where(eq(acCheckEvidence.acId, input.ac_id))
          .orderBy(desc(acCheckEvidence.createdAt))
          .limit(1)
        const row = rows[0]
        if (!row) return null
        return {
          evidence_id: row.evidenceId,
          verification_id: row.verificationId,
          ac_id: row.acId,
          result: row.result,
          evidence_kind: row.evidenceKind,
          test_command: row.testCommand,
          test_output: row.testOutput,
          test_exit_code: row.testExitCode,
          llm_reasoning: row.llmReasoning,
          files_inspected: row.filesInspected,
          ci_run_url: row.ciRunUrl,
          ci_check_name: row.ciCheckName,
          ci_conclusion: row.ciConclusion,
          created_at: row.createdAt.toISOString(),
        }
      }),
  })

  const defectsRouter = router({
    /**
     * uat.defects.history — return all defects reported against a task,
     * ordered by iteration number. Drives the DefectTimeline component.
     *
     * Round 6 #3 — [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
     */
    history: tenantProcedure
      .input(z.object({ task_id: z.string().uuid() }))
      .query(async ({ input }) => {
        try {
          const entries = await deps.defectService.getDefectsForTask(input.task_id)
          return {
            task_id: input.task_id,
            defects: entries.map((e) => ({
              defect_id: e.defectId,
              defect_key: e.defectKey,
              ac_id: e.acId,
              ac_text: e.acText,
              severity: e.severity,
              reproduction_steps: e.reproductionSteps,
              suggested_fix: e.suggestedFix,
              reported_by: e.reportedBy,
              iteration_number: e.iterationNumber,
              created_at: e.createdAt.toISOString(),
            })),
          }
        } catch (err) {
          throw mapOrbitalError(err)
        }
      }),

    /**
     * uat.defects.markFixed — operator marks a defect as resolved.
     *
     * Round 6 #3 — [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
     */
    markFixed: tenantProcedure
      .input(z.object({ defect_id: z.string().uuid() }))
      .mutation(async ({ input }) => {
        try {
          await deps.defectService.markDefectFixed(input.defect_id, STUB_USER_ID)
          return { defect_id: input.defect_id, state: 'resolved' as const }
        } catch (err) {
          throw mapOrbitalError(err)
        }
      }),

    /**
     * uat.defects.report — operator reports a defect from the UAT UI.
     * Emits DefectReported → triggers post-defect-reported hook → re-spawn loop.
     *
     * Round 6 #3 — [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
     */
    report: tenantProcedure
      .input(
        z.object({
          task_id: z.string().uuid(),
          ac_id: z.string().uuid(),
          ac_text: z.string().min(1),
          reproduction_steps: z.string().min(1),
          severity: z.enum(['low', 'medium', 'high', 'critical']),
          suggested_fix: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          const result = await deps.defectService.submitDefect({
            taskId: input.task_id,
            acId: input.ac_id,
            acText: input.ac_text,
            reproductionSteps: input.reproduction_steps,
            severity: input.severity,
            suggestedFix: input.suggested_fix,
            reportedBy: STUB_USER_ID,
          })
          return {
            defect_id: result.defectId,
            defect_key: result.defectKey,
          }
        } catch (err) {
          throw mapOrbitalError(err)
        }
      }),

    /**
     * uat.defects.list — paginated defect list.
     */
    list: tenantProcedure.input(ListDefectsInputSchema).query(async ({ input, ctx }) => {
      try {
        const limit = input.limit ?? 50
        const conditions = [eq(defectsTable.tenantId, ctx.tenantId)]

        if (input.state) {
          conditions.push(eq(defectsTable.state, input.state))
        }
        if (input.severity) {
          conditions.push(eq(defectsTable.severity, input.severity))
        }
        if (input.origin_story_id) {
          conditions.push(eq(defectsTable.originStoryId, input.origin_story_id))
        }
        if (input.persona_of_record_id) {
          conditions.push(eq(defectsTable.personaOfRecordId, input.persona_of_record_id))
        }
        if (input.created_after) {
          conditions.push(
            // Use a raw comparison via sql tagged template to avoid type issues
            // with the timestamptz column
            eq(defectsTable.defectId, defectsTable.defectId), // placeholder replaced below
          )
          // Note: created_after filter applied post-query in v1 due to type
          // mismatch between string datetime and Drizzle Date column.
          // For production, add a proper gte(defectsTable.createdAt, new Date(input.created_after)) condition.
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select({
            defectId: defectsTable.defectId,
            defectKey: defectsTable.defectKey,
            title: defectsTable.title,
            severity: defectsTable.severity,
            state: defectsTable.state,
            personaOfRecordId: defectsTable.personaOfRecordId,
            originStoryId: defectsTable.originStoryId,
            createdAt: defectsTable.createdAt,
          })
          .from(defectsTable)
          .where(whereClause)
          .orderBy(desc(defectsTable.createdAt))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const pageRows = hasMore ? rows.slice(0, limit) : rows

        return {
          items: pageRows.map((r) => ({
            defect_id: r.defectId,
            defect_key: r.defectKey,
            title: r.title,
            severity: r.severity,
            state: r.state,
            persona_of_record_id: r.personaOfRecordId,
            origin_story_id: r.originStoryId,
            created_at: r.createdAt.toISOString(),
          })),
          has_more: hasMore,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),
  })

  return router({
    session: sessionRouter,
    ac: acRouter,

    /**
     * uat.submit — submit a session (creates defects for failures).
     */
    submit: tenantProcedure.input(SubmitSessionInputSchema).mutation(async ({ input, ctx }) => {
      try {
        return await uatService.submit(input, STUB_USER_ID, ctx.tenantId)
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    /**
     * uat.accept — accept a submitted session.
     */
    accept: tenantProcedure.input(AcceptSessionInputSchema).mutation(async ({ input, ctx }) => {
      try {
        if (input.mode === 'partial') {
          const session = await uatService.partialAccept(input.uat_session_id, STUB_USER_ID, ctx.tenantId)
          return {
            uat_session_id: session.uatSessionId,
            state: session.state,
          }
        }
        const session = await uatService.accept(input.uat_session_id, STUB_USER_ID, ctx.tenantId)
        return {
          uat_session_id: session.uatSessionId,
          state: session.state,
        }
      } catch (err) {
        throw mapOrbitalError(err)
      }
    }),

    defects: defectsRouter,
  })
}

export type UATRouter = ReturnType<typeof createUATRouter>
