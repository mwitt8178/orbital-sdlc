/**
 * trpc/routers/retros.ts - tRPC router for the Retro service.
 *
 * Per TRD-10 §6 and Phase 5B brief.
 *
 * Procedures:
 *   retro.report.get
 *   retro.proposal.list
 *   retro.proposal.approve
 *   retro.proposal.reject
 *   retro.proposal.defer
 *   retro.rollback
 *   retro.outcomes.list
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, inArray, isNull, or } from 'drizzle-orm'
import { router, publicProcedure } from '../init.js'
// Round 7-01 — tenant-scoped retro procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import type { DB } from '../../db/client.js'
import {
  retroReports,
  retroProposals,
  retroProposalLayers,
  retroOutcomes,
  systemVersions,
  PROPOSAL_LAYER,
  PROPOSAL_STATUS,
} from '../../db/schema/retros.js'
import type { ProposalService } from '../../retros/proposals.js'

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface RetrosRouterDeps {
  db: DB
  proposalService: ProposalService
}

export function createRetrosRouter(deps: RetrosRouterDeps) {
  const { db, proposalService } = deps

  return router({
    // -----------------------------------------------------------------------
    // retro.report.get
    // -----------------------------------------------------------------------
    report: router({
      get: projectProcedure
        .input(z.object({ retro_report_id: z.string().uuid() }))
        .query(async ({ input, ctx }) => {
          // Round 7-02 — hub proxy
          // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
          const hub = getHubClient()
          if (hub !== null) {
            type RetroReportResult = {
              report: {
                retro_report_id: string; sprint_id: string | null;
                system_version_id: string | null; analysis_run_seq: number;
                status: string; started_at: string; completed_at: string | null;
                proposal_count: number; approved_count: number;
                rejected_count: number; deferred_count: number;
                retro_on_retro_accuracy: number | null; failure_reason: string | null;
              }
              proposals: Array<{
                retro_proposal_id: string; proposal_code: string; title: string;
                hypothesis: string | null; status: string;
                expected_impact_metric: string | null; expected_impact_direction: string | null;
                expected_impact_pct_points: number | null; confidence_score: number;
                applies_to_sprint_id: string | null; is_global: boolean;
                decided_by: string | null; decided_at: string | null;
                decision_rationale: string | null; pr_ref: string | null;
                merged_system_version_id: string | null;
              }>
              layers: Array<{ retroProposalId: string; layers: unknown[] }>
            }
            const result = await hub.query<RetroReportResult>('retro.report.get', input, ctx.tenantId!)
            if (!result.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
            return result.data
          }

          const reports = await db
            .select()
            .from(retroReports)
            .where(and(eq(retroReports.retroReportId, input.retro_report_id), eq(retroReports.tenantId, ctx.tenantId!)))
            .limit(1)
          if (reports.length === 0) {
            throw new Error(`NOT_FOUND_RETRO_REPORT: ${input.retro_report_id}`)
          }
          const report = reports[0]!

          const proposals = await db
            .select()
            .from(retroProposals)
            .where(eq(retroProposals.retroReportId, input.retro_report_id))

          // Layer rows for each proposal.
          const layerRows = []
          for (const p of proposals) {
            const ls = await db
              .select()
              .from(retroProposalLayers)
              .where(eq(retroProposalLayers.retroProposalId, p.retroProposalId))
            layerRows.push({ retroProposalId: p.retroProposalId, layers: ls })
          }

          return {
            report: {
              retro_report_id: report.retroReportId,
              sprint_id: report.sprintId,
              system_version_id: report.systemVersionId,
              analysis_run_seq: report.analysisRunSeq,
              status: report.status,
              started_at: new Date(report.startedAt).toISOString(),
              completed_at: report.completedAt
                ? new Date(report.completedAt).toISOString()
                : null,
              proposal_count: report.proposalCount,
              approved_count: report.approvedCount,
              rejected_count: report.rejectedCount,
              deferred_count: report.deferredCount,
              retro_on_retro_accuracy: report.retroOnRetroAccuracy,
              failure_reason: report.failureReason,
            },
            proposals: proposals.map((p) => ({
              retro_proposal_id: p.retroProposalId,
              proposal_code: p.proposalCode,
              title: p.title,
              hypothesis: p.hypothesis,
              status: p.status,
              expected_impact_metric: p.expectedImpactMetric,
              expected_impact_direction: p.expectedImpactDirection,
              expected_impact_pct_points: p.expectedImpactPctPoints,
              confidence_score: p.confidenceScore,
              applies_to_sprint_id: p.appliesToSprintId,
              is_global: p.isGlobal,
              decided_by: p.decidedBy,
              decided_at: p.decidedAt ? new Date(p.decidedAt).toISOString() : null,
              decision_rationale: p.decisionRationale,
              pr_ref: p.prRef,
              merged_system_version_id: p.mergedSystemVersionId,
            })),
            layers: layerRows,
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // retro.proposal.list / approve / reject / defer
    // -----------------------------------------------------------------------
    proposal: router({
      list: projectProcedure
        .input(
          z
            .object({
              retro_report_id: z.string().uuid().optional(),
              status: z.enum(PROPOSAL_STATUS).optional(),
              layer: z.enum(PROPOSAL_LAYER).optional(),
            })
            .optional(),
        )
        .query(async ({ input, ctx }) => {
          const conditions = [eq(retroProposals.tenantId, ctx.tenantId!)]
          if (input?.retro_report_id) {
            conditions.push(eq(retroProposals.retroReportId, input.retro_report_id))
          }
          if (input?.status) {
            conditions.push(eq(retroProposals.status, input.status))
          }
          let q = db.select().from(retroProposals).$dynamic()
          q = q.where(and(...conditions))
          const rows = await q

          // Filter by layer (post-DB) if requested.
          let filtered = rows
          if (input?.layer) {
            const layerRows = await db
              .select()
              .from(retroProposalLayers)
              .where(eq(retroProposalLayers.layer, input.layer))
            const ids = new Set(layerRows.map((l) => l.retroProposalId))
            filtered = rows.filter((r) => ids.has(r.retroProposalId))
          }

          return filtered.map((p) => ({
            retro_proposal_id: p.retroProposalId,
            retro_report_id: p.retroReportId,
            proposal_code: p.proposalCode,
            title: p.title,
            hypothesis: p.hypothesis,
            status: p.status,
            expected_impact_metric: p.expectedImpactMetric,
            expected_impact_pct_points: p.expectedImpactPctPoints,
            confidence_score: p.confidenceScore,
            decided_by: p.decidedBy,
            pr_ref: p.prRef,
            merged_system_version_id: p.mergedSystemVersionId,
          }))
        }),

      approve: projectProcedure
        .input(
          z.object({
            retro_proposal_id: z.string().uuid(),
            rationale: z.string().min(1),
            user_id: z.string().min(1),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          const result = await proposalService.approve(
            input.retro_proposal_id,
            input.rationale,
            input.user_id,
            {},
            ctx.tenantId,
          )
          return {
            retro_proposal_id: result.retroProposalId,
            pr_ref: result.prRef,
            merged_system_version_id: result.mergedSystemVersionId,
            git_sha: result.gitSha,
            version_number: result.versionNumber,
          }
        }),

      reject: projectProcedure
        .input(
          z.object({
            retro_proposal_id: z.string().uuid(),
            rationale: z.string().min(1),
            user_id: z.string().min(1),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          const result = await proposalService.reject(
            input.retro_proposal_id,
            input.rationale,
            input.user_id,
            {},
            ctx.tenantId,
          )
          return { retro_proposal_id: result.retroProposalId }
        }),

      defer: projectProcedure
        .input(
          z.object({
            retro_proposal_id: z.string().uuid(),
            rationale: z.string().min(1),
            user_id: z.string().min(1),
            defer_until_sprint_id: z.string().uuid().optional(),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          const opts: { deferUntilSprintId?: string } = {}
          if (input.defer_until_sprint_id !== undefined) {
            opts.deferUntilSprintId = input.defer_until_sprint_id
          }
          const result = await proposalService.defer(
            input.retro_proposal_id,
            input.rationale,
            input.user_id,
            opts,
            ctx.tenantId,
          )
          return { retro_proposal_id: result.retroProposalId }
        }),
    }),

    // -----------------------------------------------------------------------
    // retro.rollback
    // -----------------------------------------------------------------------
    rollback: projectProcedure
      .input(
        z.object({
          rolled_back_system_version_id: z.string().uuid(),
          rationale: z.string().min(1),
          user_id: z.string().min(1),
          confirm_with_dependents: z.boolean().default(false),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const result = await proposalService.rollback(
          input.rolled_back_system_version_id,
          input.rationale,
          input.user_id,
          { confirmWithDependents: input.confirm_with_dependents },
          ctx.tenantId,
        )
        return {
          new_system_version_id: result.newSystemVersionId,
          git_tag: result.gitTag,
          git_sha: result.gitSha,
          impact_preview: {
            affected_files: result.impactPreview.affectedFiles,
            dependent_proposal_ids: result.impactPreview.dependentProposalIds,
          },
        }
      }),

    // -----------------------------------------------------------------------
    // retro.outcomes.list
    // -----------------------------------------------------------------------
    outcomes: router({
      list: projectProcedure
        .input(
          z
            .object({
              system_version_id: z.string().uuid().optional(),
              retro_proposal_id: z.string().uuid().optional(),
            })
            .optional(),
        )
        .query(async ({ input, ctx }) => {
          // retroOutcomes has no tenantId column — scope via retroProposals which does.
          // Fetch the set of proposal IDs belonging to this tenant first.
          const tenantProposalRows = await db
            .select({ retroProposalId: retroProposals.retroProposalId })
            .from(retroProposals)
            .where(eq(retroProposals.tenantId, ctx.tenantId!))
          const tenantProposalIds = tenantProposalRows.map((r) => r.retroProposalId)

          if (tenantProposalIds.length === 0) return []

          let q = db.select().from(retroOutcomes).$dynamic()
          q = q.where(inArray(retroOutcomes.retroProposalId, tenantProposalIds))
          if (input?.system_version_id) {
            q = q.where(and(inArray(retroOutcomes.retroProposalId, tenantProposalIds), eq(retroOutcomes.systemVersionId, input.system_version_id)))
          } else if (input?.retro_proposal_id) {
            // Verify proposal belongs to this tenant (already scoped by tenantProposalIds)
            if (!tenantProposalIds.includes(input.retro_proposal_id)) return []
            q = q.where(and(inArray(retroOutcomes.retroProposalId, tenantProposalIds), eq(retroOutcomes.retroProposalId, input.retro_proposal_id)))
          }
          const rows = await q
          return rows.map((r) => ({
            retro_outcome_id: r.retroOutcomeId,
            retro_proposal_id: r.retroProposalId,
            system_version_id: r.systemVersionId,
            metric_key: r.metricKey,
            expected_direction: r.expectedDirection,
            expected_pct_points: r.expectedPctPoints,
            actual_pct_points: r.actualPctPoints,
            matched_expectation: r.matchedExpectation,
            tolerance_band: r.toleranceBand,
            window_sprint_count: r.windowSprintCount,
            window_open: r.matchedExpectation === null,
            computed_at: r.computedAt ? new Date(r.computedAt).toISOString() : null,
          }))
        }),
    }),

    // -----------------------------------------------------------------------
    // retro.versions.list  - convenience listing of system_versions
    // -----------------------------------------------------------------------
    versions: router({
      list: projectProcedure.query(async ({ ctx }) => {
        // systemVersions has no tenantId — scope via retroReports (which does).
        // Include versions whose retroReportId belongs to this tenant, plus
        // versions with no retroReportId (global/rollback versions).
        const tenantReportRows = await db
          .select({ retroReportId: retroReports.retroReportId })
          .from(retroReports)
          .where(eq(retroReports.tenantId, ctx.tenantId!))
        const tenantReportIds = tenantReportRows.map((r) => r.retroReportId)

        const rows = await db
          .select()
          .from(systemVersions)
          .where(
            tenantReportIds.length > 0
              ? or(isNull(systemVersions.retroReportId), inArray(systemVersions.retroReportId, tenantReportIds))
              : isNull(systemVersions.retroReportId),
          )
        return rows.map((r) => ({
          system_version_id: r.systemVersionId,
          version_number: r.versionNumber,
          parent_system_version_id: r.parentSystemVersionId,
          git_tag: r.gitTag,
          git_sha: r.gitSha,
          shipped_at: new Date(r.shippedAt).toISOString(),
          shipped_by: r.shippedBy,
          is_rollback: r.isRollback,
          rolled_back_version_id: r.rolledBackVersionId,
          retro_report_id: r.retroReportId,
        }))
      }),
    }),
  })
}

export type RetrosRouter = ReturnType<typeof createRetrosRouter>
