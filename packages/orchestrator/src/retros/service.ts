/**
 * retros/service.ts - The RetroService.
 *
 * Per TRD-10 v0.1 §6.8 and Phase 5B brief.
 *
 * Responsibilities:
 *   - subscribe to SprintCompleted via EventStore.subscribe
 *   - on each SprintCompleted, run analyze(sprintId)
 *   - analyze(): create retro_reports row (status='analyzing'); emit
 *     RetroAnalysisStarted; mine sprint events for cost/routing/hooks/verifier
 *     /defects/escalations to compute structured metrics; spawn the retro-
 *     analyst persona via Scheduler.addTask OR (test path) call
 *     synthesizeProposalForTest; persist proposals (real DB inserts) + emit
 *     RetroProposed per proposal; emit RetroReportGenerated; transition the
 *     report to 'ready'.
 *
 * The retro-analyst capability bundle is issued via CapabilityAuthority.issue
 * with scopes: { board_read: ['*'], channel_read: ['#sprint-{sprintId}'],
 *                files_write: [] }.
 *
 * Integration tests bypass the real persona spawn via the public test helper
 * `synthesizeProposalForTest` which deterministically generates a known
 * proposal from sprint metrics. Production wires a fake-retro-analyst.mjs
 * surrogate spawn (per Phase 5B brief). The integration tests in this phase
 * use the synth helper.
 */

import { uuidv7 } from 'uuidv7'
import { eq, sql as dSQL } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { ICapabilityAuthority } from '../capabilities/authority.js'
import type { PersonaLoader } from '../personas/loader.js'
import type { Scheduler } from '../orchestration/scheduler.js'
import { logger } from '../config/logger.js'
import { sprints } from '../db/schema/backlog.js'
import {
  retroReports,
  retroAnalyses,
  retroProposals,
  retroProposalLayers,
} from '../db/schema/retros.js'
import { tasks as taskTable } from '../db/schema/orchestration.js'
import {
  DEFAULT_RETRY_BUDGET,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_WALL_CLOCK_TIMEOUT_MS,
} from '../orchestration/types.js'
import {
  ProposalSchema,
  assertExactlyOneDominant,
  assertLayerPathMatch,
  RetroProposedPayloadV1,
  type Proposal,
} from './types.js'
import type { AnthropicDriver } from '../personas/anthropic-driver.js'
import { AnthropicDriverNoKeyError } from '../personas/anthropic-driver.js'
import {
  buildRetroAnalystSystemPrompt,
  buildRetroAnalystUserPrompt,
  RetroAnalystResponseSchema,
  type RetroSprintContext,
  type RetroAnalystProposal,
} from '../personas/prompts/retro-analyst.js'
// Round cost-guardrails — pre-flight budget check before retro-analyst Claude call.
// [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
import { assertBudget, BudgetExceededError } from '@orbital/domain/cost/assert-budget.js'
// Estimated cost: claude-sonnet-4-6 at 8k input + 3k output for retro analysis.
// 8000/1M * $3.00 + 3072/1M * $15.00 = $0.024 + $0.046 = $0.070
const RETRO_ESTIMATED_COST_USD = 0.070

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface RetroServiceOptions {
  /** Override default install_id (used in capability bundles). */
  installId?: string
  /**
   * Optional callback invoked after the report transitions to 'ready'. Tests
   * can use this to wait on the analysis pipeline without blocking on the
   * real persona spawn.
   */
  onAnalysisComplete?: (retroReportId: string, sprintId: string) => void
  /**
   * Disable real persona spawn. When true, the service relies on
   * synthesizeProposalForTest being called externally to provide proposals.
   * Default: false (production behavior would spawn the persona; tests pass
   * true and call synth helpers).
   */
  disableRealSpawn?: boolean
  /**
   * Scheduler used to enqueue the retro-analyst persona spawn. When omitted,
   * spawn is suppressed (capability is still issued for SoD audit). Boot wires
   * the real Scheduler in production; unit tests construct the service without
   * a Scheduler and rely on synthesizeProposalForTest to drive proposals.
   */
  scheduler?: Scheduler
  /**
   * Optional AnthropicDriver. When present and ANTHROPIC_API_KEY is set, the
   * analyze() pipeline invokes the retro-analyst persona via the driver and
   * persists the proposals it returns. When absent or the driver throws, the
   * service preserves its prior behaviour (capability issued + scheduler task
   * queued; production worker spawn is left to the scheduler tick).
   */
  driver?: AnthropicDriver | null
  /**
   * Optional project ID for pre-flight budget enforcement on the retro-analyst
   * Claude call. When present, assertBudget() is called before driver.invoke().
   * When absent, budget check is skipped (retro is low-frequency; no projectId
   * is available from sprint context alone without an extra DB join).
   * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
   */
  projectId?: string
}

export interface AnalyzeResult {
  retroReportId: string
  sprintId: string
  status: 'analyzing' | 'ready' | 'failed'
}

export interface RetroService {
  /** Subscribe to SprintCompleted events via EventStore.subscribe. */
  start(): void
  /** Unsubscribe; idempotent. */
  stop(): void
  /** Direct entry point: process a SprintCompleted event for the given sprint. */
  onSprintCompleted(sprintId: string): Promise<AnalyzeResult>
  /** Run an analysis for a sprint (idempotent on (sprint_id, analysis_run_seq=1)). */
  analyze(sprintId: string, opts?: { forceRerun?: boolean }): Promise<AnalyzeResult>
  /**
   * Test-only: synthesize and persist a single proposal under the supplied
   * report. Bypasses the real persona spawn. The supplied Proposal is
   * validated; layer/path mismatch and missing-dominant-layer raise.
   */
  synthesizeProposalForTest(
    retroReportId: string,
    proposal: Proposal,
    opts?: { systemActor?: Actor; traceId?: string },
  ): Promise<{ retroProposalId: string }>
  /** Test-only: finalize a report (set status='ready', emit RetroReportGenerated). */
  finalizeReportForTest(retroReportId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'retro_service' }

export class DefaultRetroService implements RetroService {
  private unsubscribe: (() => void) | null = null
  private readonly disableRealSpawn: boolean
  private readonly onAnalysisComplete?: (reportId: string, sprintId: string) => void
  private readonly scheduler?: Scheduler
  private readonly driver: AnthropicDriver | null
  // [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
  private readonly projectId?: string

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly authority: ICapabilityAuthority,
    /** Reserved for future real persona spawn (Phase 5B brief: prefer the
     *  fake-retro-analyst.mjs surrogate in tests; production spawns the real
     *  retro-analyst persona via this loader). */
    private readonly _personaLoader: PersonaLoader,
    private readonly installId: string,
    options: RetroServiceOptions = {},
  ) {
    // _personaLoader is intentionally retained for future spawn integration.
    void this._personaLoader
    this.disableRealSpawn = options.disableRealSpawn ?? false
    if (options.onAnalysisComplete !== undefined) {
      this.onAnalysisComplete = options.onAnalysisComplete
    }
    if (options.scheduler !== undefined) {
      this.scheduler = options.scheduler
    }
    this.driver = options.driver ?? null
    if (options.projectId !== undefined) {
      this.projectId = options.projectId
    }
  }

  // -------------------------------------------------------------------------
  // start - subscribe to SprintCompleted via EventStore.
  // -------------------------------------------------------------------------

  start(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.eventStore.subscribe(null, (envelope) => {
      if (envelope.event_type !== 'SprintCompleted') return
      // Best-effort fire-and-forget. Errors are logged.
      void this.onSprintCompleted(envelope.aggregate_id).catch((err: unknown) => {
        logger.error(
          { err, sprintId: envelope.aggregate_id },
          'RetroService: onSprintCompleted failed',
        )
      })
    })
    logger.info('RetroService: subscribed to SprintCompleted')
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  stop(): void {
    if (this.unsubscribe === null) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  // -------------------------------------------------------------------------
  // onSprintCompleted - direct entry point used by the integration test.
  // -------------------------------------------------------------------------

  async onSprintCompleted(sprintId: string): Promise<AnalyzeResult> {
    return await this.analyze(sprintId)
  }

  // -------------------------------------------------------------------------
  // analyze - the main pipeline.
  // -------------------------------------------------------------------------

  async analyze(
    sprintId: string,
    opts: { forceRerun?: boolean } = {},
  ): Promise<AnalyzeResult> {
    // Idempotency check: existing report for this sprint with run_seq=1?
    const existing = await this.db
      .select()
      .from(retroReports)
      .where(eq(retroReports.sprintId, sprintId))
      .limit(1)
    if (existing.length > 0 && !opts.forceRerun) {
      const e = existing[0]!
      return {
        retroReportId: e.retroReportId,
        sprintId: e.sprintId,
        status: e.status as 'analyzing' | 'ready' | 'failed',
      }
    }

    // Validate that the sprint exists in the backlog.
    const sprintRows = await this.db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprintId))
      .limit(1)
    if (sprintRows.length === 0) {
      throw new OrbitalError('NOT_FOUND_SPRINT', `sprint ${sprintId} not found`)
    }
    const sprint = sprintRows[0]!

    // Fetch the system_version_id pinned by sprint_commitments (additive col).
    let pinnedVersionId: string | null = null
    try {
      const pin = await this.db.execute(
        dSQL`SELECT system_version_id FROM sprint_commitments WHERE sprint_id = ${sprintId} LIMIT 1`,
      )
      // postgres-js returns array of rows.
      const rows = pin as unknown as Array<{ system_version_id: string | null }>
      if (rows[0]?.system_version_id) pinnedVersionId = rows[0].system_version_id
    } catch (err) {
      logger.debug({ err, sprintId }, 'RetroService.analyze: no version pin lookup')
    }

    const traceId = uuidv7()
    const retroReportId = uuidv7()
    const startedAt = new Date()
    const startEventId = uuidv7()

    // Insert the report row.
    await this.db.insert(retroReports).values({
      retroReportId,
      sprintId,
      systemVersionId: pinnedVersionId,
      analysisRunSeq: 1,
      status: 'analyzing',
      startedAt,
      proposalCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      deferredCount: 0,
      createdEventId: startEventId,
    })

    // Emit RetroAnalysisStarted.
    const startEv: EventInput = {
      aggregate_id: retroReportId,
      aggregate_type: 'retro',
      event_type: 'RetroAnalysisStarted',
      payload: {
        retro_report_id: retroReportId,
        sprint_id: sprintId,
        system_version_id: pinnedVersionId,
        analysis_run_seq: 1,
        triggered_by: 'sprint_completed',
        schema_version: 1,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: startedAt.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(startEv)

    // Compute structured metrics (real SQL queries; partial-success allowed).
    try {
      await this.computeAndPersistMetrics(retroReportId, sprint.startedAt, sprint.completedAt)
    } catch (err) {
      logger.warn({ err, retroReportId }, 'RetroService.analyze: metric computation degraded')
    }

    // Issue the retro-analyst capability. The bundle is the production
    // boundary; in tests we still issue it (it's cheap) so the SoD path is
    // exercised.
    let analystTaskId: string | null = null
    try {
      const sessionId = uuidv7()
      analystTaskId = uuidv7()
      await this.authority.issue({
        install_id: this.installId,
        persona_id: 'retro-analyst',
        task_id: analystTaskId,
        sprint_id: sprintId,
        session_id: sessionId,
        scopes: {
          files_read: ['**'],
          files_write: [],
          board_read: ['*'],
          board_mutate: [],
          channel_read: [`#sprint-${sprintId}`],
          channel_post: [],
          secrets: [],
          network_egress: ['api.anthropic.com'],
          spawn_subagent: false,
          git_commit: [],
          ceremony_role: ['observer'],
        },
        ttl_ms: 600_000,
        justification: `Phase 5B retro analysis for sprint ${sprintId}`,
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
      })
      logger.info({ retroReportId, sprintId }, 'RetroService: issued retro-analyst capability')
    } catch (err) {
      logger.error({ err, sprintId }, 'RetroService.analyze: capability issuance failed')
      // Mark report failed; surface error.
      await this.markReportFailed(retroReportId, (err as Error).message)
      throw err
    }

    // AnthropicDriver path (preferred): invoke the retro-analyst persona
    // in-process. Cheaper, faster, and produces the same RetroProposed events
    // as the spawned-worker path. Errors fall through to the scheduler path
    // so we never end up with a stuck 'analyzing' report.
    let driverProducedProposals = false
    if (this.driver && !this.disableRealSpawn) {
      try {
        await this._invokeAnalystViaDriver(retroReportId, sprintId, traceId)
        driverProducedProposals = true
        // Mark the report ready immediately — driver path doesn't need scheduler.
        await this.finalizeReportForTest(retroReportId)
      } catch (err) {
        if (err instanceof AnthropicDriverNoKeyError) {
          logger.debug(
            { sprintId, retroReportId },
            'RetroService.analyze: ANTHROPIC_API_KEY unset; falling back to scheduler path',
          )
        } else {
          logger.warn(
            { err, sprintId, retroReportId },
            'RetroService.analyze: AnthropicDriver invocation failed; falling back to scheduler path',
          )
        }
      }
    }

    // Real persona spawn (TRD-10 §7.3): enqueue a synthetic task for the
    // retro-analyst persona via the Scheduler. The scheduler picks the task
    // up on its next tick, issues a routing decision, and spawns the worker.
    // Test paths (disableRealSpawn=true OR no scheduler injected) skip this
    // and rely on synthesizeProposalForTest to drive proposals deterministically.
    //
    // Skipped entirely when the driver path already produced proposals.
    if (driverProducedProposals) {
      // No-op — proposals already produced and the report is finalized.
    } else
    //
    // NOTE on Scheduler API: the brief specifies `scheduler.addTask({...})`
    // but the existing Scheduler interface only exposes `addSprint(s, tasks)`.
    // The closest production-ready path is to insert a real `tasks` row that
    // the existing tick loop will pick up, then call `addSprint` on a sentinel
    // sprint id ("retro-sprint-{sprintId}") so the scheduler tracks it.
    if (this.scheduler && !this.disableRealSpawn && analystTaskId) {
      try {
        // sprintId is a real UUID; we use it directly as the owning sprint for
        // the analyst task so the scheduler picks it up under the existing
        // sprint context (the retro analyst is logically scoped to the sprint
        // it analyzes).
        await this.db.insert(taskTable).values({
          taskId: analystTaskId,
          sprintId,
          ticketId: `RETRO-${analystTaskId.slice(0, 8)}`,
          title: `Retro analysis for sprint ${sprintId}`,
          description: `Synthesized retro-analyst task for retro_report_id=${retroReportId}.`,
          acceptanceCriteria: [],
          personaId: 'retro-analyst',
          riskClass: 'standard',
          state: 'ready',
          attemptCount: 0,
          retryBudget: DEFAULT_RETRY_BUDGET,
          wallClockTimeoutMs: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
          tokenBudget: DEFAULT_TOKEN_BUDGET,
          tokensConsumed: 0,
          declaredWritePaths: [],
          createdByEventId: uuidv7(),
        })
        // Ensure the scheduler is tracking this sprint so the tick loop allocates a slot.
        this.scheduler.addSprint({ sprintId, priority: 3 }, [])
        // Trigger an immediate tick so the spawn happens without waiting for the
        // next periodic loop. Errors here are non-fatal — the next periodic
        // tick will pick up the task.
        void this.scheduler.tick().catch((err: unknown) => {
          logger.warn(
            { err, sprintId, retroReportId },
            'RetroService.analyze: immediate scheduler.tick failed; will be retried by periodic loop',
          )
        })
        logger.info(
          { retroReportId, sprintId, analystTaskId },
          'RetroService.analyze: enqueued retro-analyst task for scheduler',
        )
      } catch (err) {
        logger.error(
          { err, sprintId, retroReportId },
          'RetroService.analyze: failed to enqueue retro-analyst task; capability still issued, report stays analyzing',
        )
        // Non-fatal — report stays in analyzing; an operator can retrigger.
      }
    }

    if (this.onAnalysisComplete) {
      this.onAnalysisComplete(retroReportId, sprintId)
    }

    return {
      retroReportId,
      sprintId,
      status: 'analyzing',
    }
  }

  // -------------------------------------------------------------------------
  // synthesizeProposalForTest - persist a Proposal under a report.
  // -------------------------------------------------------------------------

  async synthesizeProposalForTest(
    retroReportId: string,
    proposal: Proposal,
    opts: { systemActor?: Actor; traceId?: string } = {},
  ): Promise<{ retroProposalId: string }> {
    const validated = ProposalSchema.parse(proposal)

    // Validate exactly-one-dominant.
    assertExactlyOneDominant(validated.layers)
    // Validate every layer's target_path.
    for (const layer of validated.layers) {
      assertLayerPathMatch(layer.layer, layer.target_path)
    }

    // Check the report exists and is in 'analyzing' or 'ready' state.
    const reports = await this.db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, retroReportId))
      .limit(1)
    if (reports.length === 0) {
      throw new OrbitalError('NOT_FOUND_RETRO_REPORT', `report ${retroReportId} not found`)
    }
    const report = reports[0]!
    if (report.status !== 'analyzing' && report.status !== 'ready' && report.status !== 'reviewing') {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `report ${retroReportId} is in state ${report.status}; cannot add proposals`,
      )
    }

    const retroProposalId = uuidv7()
    const traceId = opts.traceId ?? uuidv7()
    const actor = opts.systemActor ?? SYSTEM_ACTOR
    const occurredAt = new Date()
    const createdEventId = uuidv7()

    // Pick the dominant layer for the row's "rollup".
    const dominant = validated.layers.find((l) => l.is_dominant)
    if (!dominant) {
      throw new Error('VALIDATION_PROPOSAL_MISSING_DOMINANT_LAYER: no dominant layer found')
    }

    await this.db.insert(retroProposals).values({
      retroProposalId,
      retroReportId,
      proposalCode: validated.proposal_code,
      title: validated.title,
      hypothesis: validated.hypothesis,
      expectedImpactMetric: validated.expected_impact.metric_key,
      expectedImpactDirection: validated.expected_impact.direction,
      expectedImpactPctPoints: validated.expected_impact.pct_points,
      expectedImpactCi: validated.expected_impact.confidence_interval ?? null,
      rollbackPath: validated.rollback_path,
      evidenceRefs: validated.evidence_refs,
      appliesToSprintId: validated.applies_to_sprint_id ?? null,
      isGlobal: validated.is_global,
      currentValue: validated.current_value ?? null,
      proposedValue: validated.proposed_value ?? null,
      confidenceScore: validated.confidence_score,
      status: 'pending',
      createdEventId,
    })

    // Insert layer rows.
    const layerRows = validated.layers.map((l) => ({
      retroProposalLayerId: uuidv7(),
      retroProposalId,
      layer: l.layer,
      targetPath: l.target_path,
      changeType: l.change_type,
      diffPreview: l.diff_preview ?? null,
      isDominant: l.is_dominant,
    }))
    await this.db.insert(retroProposalLayers).values(layerRows)

    // Bump report's proposal_count.
    await this.db
      .update(retroReports)
      .set({ proposalCount: report.proposalCount + 1 })
      .where(eq(retroReports.retroReportId, retroReportId))

    // Emit RetroProposed.
    const payload = RetroProposedPayloadV1.parse({
      retro_proposal_id: retroProposalId,
      retro_report_id: retroReportId,
      proposal_code: validated.proposal_code,
      title: validated.title,
      hypothesis: validated.hypothesis,
      expected_impact: validated.expected_impact,
      rollback_path: validated.rollback_path,
      layers: validated.layers,
      evidence_refs: validated.evidence_refs,
      confidence_score: validated.confidence_score,
      schema_version: 1,
    })
    const ev: EventInput = {
      aggregate_id: retroProposalId,
      aggregate_type: 'retro',
      event_type: 'RetroProposed',
      payload,
      actor,
      trace_id: traceId,
      occurred_at: occurredAt.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return { retroProposalId }
  }

  // -------------------------------------------------------------------------
  // finalizeReportForTest - transition report to 'ready' and emit
  // RetroReportGenerated.
  // -------------------------------------------------------------------------

  async finalizeReportForTest(retroReportId: string): Promise<void> {
    const reports = await this.db
      .select()
      .from(retroReports)
      .where(eq(retroReports.retroReportId, retroReportId))
      .limit(1)
    if (reports.length === 0) {
      throw new OrbitalError('NOT_FOUND_RETRO_REPORT', `report ${retroReportId} not found`)
    }
    const report = reports[0]!

    const completedAt = new Date()
    const durationMs = completedAt.getTime() - new Date(report.startedAt).getTime()

    await this.db
      .update(retroReports)
      .set({
        status: 'ready',
        completedAt,
      })
      .where(eq(retroReports.retroReportId, retroReportId))

    // Compute layer distribution.
    const layerRows = await this.db
      .select()
      .from(retroProposalLayers)
      .innerJoin(retroProposals, eq(retroProposalLayers.retroProposalId, retroProposals.retroProposalId))
      .where(eq(retroProposals.retroReportId, retroReportId))

    const layerDist: Record<string, number> = {}
    for (const r of layerRows) {
      if (r.retro_proposal_layers.isDominant) {
        const layer = r.retro_proposal_layers.layer
        layerDist[layer] = (layerDist[layer] ?? 0) + 1
      }
    }

    const traceId = uuidv7()
    const ev: EventInput = {
      aggregate_id: retroReportId,
      aggregate_type: 'retro',
      event_type: 'RetroReportGenerated',
      payload: {
        retro_report_id: retroReportId,
        sprint_id: report.sprintId,
        proposal_count: report.proposalCount,
        proposal_layer_distribution: layerDist,
        duration_ms: durationMs,
        schema_version: 1,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: completedAt.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  // -------------------------------------------------------------------------
  // Internal: mark a report as failed.
  // -------------------------------------------------------------------------

  private async markReportFailed(retroReportId: string, reason: string): Promise<void> {
    await this.db
      .update(retroReports)
      .set({
        status: 'failed',
        failureReason: reason,
        completedAt: new Date(),
      })
      .where(eq(retroReports.retroReportId, retroReportId))
  }

  // -------------------------------------------------------------------------
  // Internal: compute and persist sprint metrics from the audit log.
  // -------------------------------------------------------------------------

  private async computeAndPersistMetrics(
    retroReportId: string,
    sprintStartedAt: Date | null,
    sprintCompletedAt: Date | null,
  ): Promise<void> {
    if (!sprintStartedAt) return

    const start = sprintStartedAt
    const end = sprintCompletedAt ?? new Date()

    // M1: cycle time (best-effort).
    const cycleTimeMetric = await this.computeCycleTime(start, end).catch(() => null)
    if (cycleTimeMetric !== null) {
      await this.db.insert(retroAnalyses).values({
        retroAnalysisId: uuidv7(),
        retroReportId,
        metricKey: 'cycle_time',
        metricValue: cycleTimeMetric,
        flagged: false,
      })
    }

    // M3: escalation rate.
    const escalationMetric = await this.computeEscalationRate(start, end).catch(() => null)
    if (escalationMetric !== null) {
      await this.db.insert(retroAnalyses).values({
        retroAnalysisId: uuidv7(),
        retroReportId,
        metricKey: 'escalation_rate',
        metricValue: escalationMetric,
        flagged:
          typeof escalationMetric.rate_bp === 'number' && escalationMetric.rate_bp > 2500,
      })
    }

    // M6: capability denials.
    const capMetric = await this.computeCapabilityDenials(start, end).catch(() => null)
    if (capMetric !== null) {
      await this.db.insert(retroAnalyses).values({
        retroAnalysisId: uuidv7(),
        retroReportId,
        metricKey: 'capability_violations',
        metricValue: capMetric,
        flagged: capMetric.total > 10,
      })
    }
  }

  private async computeCycleTime(
    start: Date,
    end: Date,
  ): Promise<{ p50_ms: number | null; p90_ms: number | null; n_tasks: number }> {
    const rows = await this.db.execute(dSQL`
      WITH task_durations AS (
        SELECT
          aggregate_id AS task_id,
          EXTRACT(EPOCH FROM (
            MAX(occurred_at) FILTER (WHERE event_type = 'TaskCompleted')
            - MIN(occurred_at) FILTER (WHERE event_type = 'TaskCreated')
          )) * 1000 AS ms
        FROM audit.events
        WHERE aggregate_type = 'task' AND occurred_at BETWEEN ${start} AND ${end}
        GROUP BY aggregate_id
        HAVING COUNT(*) FILTER (WHERE event_type = 'TaskCompleted') > 0
      )
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50_ms,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ms) AS p90_ms,
        COUNT(*) AS n_tasks
      FROM task_durations;
    `)
    const r = (rows as unknown as Array<{
      p50_ms: number | null
      p90_ms: number | null
      n_tasks: number
    }>)[0]
    return {
      p50_ms: r?.p50_ms ?? null,
      p90_ms: r?.p90_ms ?? null,
      n_tasks: Number(r?.n_tasks ?? 0),
    }
  }

  private async computeEscalationRate(
    start: Date,
    end: Date,
  ): Promise<{ rate_bp: number | null; escalated_count: number; raised_count: number }> {
    const rows = await this.db.execute(dSQL`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'BlockerEscalated')::int AS escalated_count,
        COUNT(*) FILTER (WHERE event_type = 'BlockerRaised')::int AS raised_count
      FROM audit.events
      WHERE event_type IN ('BlockerRaised', 'BlockerEscalated')
        AND occurred_at BETWEEN ${start} AND ${end}
    `)
    const r = (rows as unknown as Array<{ escalated_count: number; raised_count: number }>)[0]
    const escalated = Number(r?.escalated_count ?? 0)
    const raised = Number(r?.raised_count ?? 0)
    const rate = raised > 0 ? Math.round((escalated / raised) * 10_000) : null
    return { rate_bp: rate, escalated_count: escalated, raised_count: raised }
  }

  private async computeCapabilityDenials(
    start: Date,
    end: Date,
  ): Promise<{ total: number; by_persona: Array<{ persona_id: string; denials: number }> }> {
    const totalRows = await this.db.execute(dSQL`
      SELECT COUNT(*)::int AS total
      FROM audit.events
      WHERE event_type = 'CapabilityDenied'
        AND occurred_at BETWEEN ${start} AND ${end}
    `)
    const total = Number((totalRows as unknown as Array<{ total: number }>)[0]?.total ?? 0)

    const byPersonaRows = await this.db.execute(dSQL`
      SELECT
        COALESCE(payload->>'persona_id', actor->>'persona_id') AS persona_id,
        COUNT(*)::int AS denials
      FROM audit.events
      WHERE event_type = 'CapabilityDenied'
        AND occurred_at BETWEEN ${start} AND ${end}
      GROUP BY persona_id
      ORDER BY denials DESC
    `)
    const byPersona = (byPersonaRows as unknown as Array<{
      persona_id: string | null
      denials: number
    }>).map((r) => ({
      persona_id: r.persona_id ?? '<unknown>',
      denials: Number(r.denials),
    }))

    return { total, by_persona: byPersona }
  }

  // -------------------------------------------------------------------------
  // AnthropicDriver invocation — produces proposals from sprint metrics.
  // -------------------------------------------------------------------------

  private async _invokeAnalystViaDriver(
    retroReportId: string,
    sprintId: string,
    traceId: string,
  ): Promise<void> {
    if (!this.driver) {
      throw new AnthropicDriverNoKeyError()
    }

    // Pre-flight budget check — block if monthly hard cap would be exceeded.
    // [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
    if (this.projectId) {
      // Sprint tenantId is not available here without a DB lookup; we use the
      // sentinel tenant (install-scoped). Real tenant is wired via RetroServiceOptions.projectId.
      const sprintRows = await this.db
        .select({ tenantId: sprints.tenantId })
        .from(sprints)
        .where(eq(sprints.sprintId, sprintId))
        .limit(1)
      const tenantId = sprintRows[0]?.tenantId ?? '00000000-0000-0000-0000-000000000000'

      try {
        await assertBudget({
          tenantId,
          projectId:         this.projectId,
          sprintId,
          persona:           'retro-analyst',
          estimatedCostUsd:  RETRO_ESTIMATED_COST_USD,
          db:                this.db,
        })
      } catch (budgetErr) {
        if (budgetErr instanceof BudgetExceededError) {
          logger.warn(
            { retroReportId, sprintId, message: budgetErr.message },
            'RetroService: retro-analyst blocked by budget cap — skipping driver invoke',
          )
          throw budgetErr
        }
        throw budgetErr
      }
    }

    // 1. Build the sprint context blob from the metrics rows already persisted.
    const ctx = await this._buildAnalystContext(retroReportId, sprintId)

    const systemPrompt = buildRetroAnalystSystemPrompt()
    const userPrompt = buildRetroAnalystUserPrompt(ctx)

    // 2. Invoke the driver.
    const result = await this.driver.invoke({
      persona: 'retro-analyst',
      riskClass: 'standard',
      sessionId: retroReportId, // session-scoped to the report for cost grouping
      systemPrompt,
      userPrompt,
      responseSchema: RetroAnalystResponseSchema,
      maxTokens: 3072,
      traceId,
    })

    logger.info(
      {
        retroReportId,
        sprintId,
        proposalCount: result.result.proposals.length,
        model: result.model,
        costUsdMicros: result.costUsdMicros,
      },
      'RetroService: retro-analyst returned proposals',
    )

    // 3. Persist each proposal (validating against ProposalSchema first).
    for (const p of result.result.proposals) {
      try {
        const proposal = mapAnalystProposalToProposal(p, sprintId)
        await this.synthesizeProposalForTest(retroReportId, proposal, { traceId })
      } catch (err) {
        logger.warn(
          { err, retroReportId, proposalCode: p.proposal_code },
          'RetroService: skipping invalid proposal from analyst',
        )
      }
    }
  }

  private async _buildAnalystContext(
    retroReportId: string,
    sprintId: string,
  ): Promise<RetroSprintContext> {
    // Pull the sprint window so cost queries are scoped correctly.
    const sprintRows = await this.db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprintId))
      .limit(1)
    const sprint = sprintRows[0]
    const startedAt = sprint?.startedAt?.toISOString() ?? null
    const completedAt = sprint?.completedAt?.toISOString() ?? null

    // Aggregate cost across the sprint.
    const costRows = await this.db.execute(dSQL`
      SELECT COALESCE(SUM(cost_usd_micros), 0)::bigint AS total_cost_micros
      FROM cost_accounting
      WHERE sprint_id = ${sprintId}
    `)
    const totalCostUsdMicros = Number(
      (costRows as unknown as Array<{ total_cost_micros: number | string }>)[0]
        ?.total_cost_micros ?? 0,
    )

    // Pull the persisted analyses rows for raw metrics.
    const analyses = await this.db
      .select()
      .from(retroAnalyses)
      .where(eq(retroAnalyses.retroReportId, retroReportId))

    const rawMetrics: Record<string, unknown> = {}
    for (const a of analyses) {
      rawMetrics[a.metricKey] = a.metricValue
    }

    // Cycle time / escalation come from rawMetrics if present.
    const cycle = rawMetrics['cycle_time'] as
      | { p50_ms?: number | null; p90_ms?: number | null; n_tasks?: number }
      | undefined
    const escalation = rawMetrics['escalation_rate'] as
      | { rate_bp?: number | null; escalated_count?: number; raised_count?: number }
      | undefined
    const capDenials = rawMetrics['capability_violations'] as
      | { total?: number }
      | undefined

    // Counts from the audit log.
    const taskRows = await this.db.execute(dSQL`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'TaskCompleted')::int AS completed_count,
        COUNT(*) FILTER (WHERE event_type = 'TaskFailed')::int AS failed_count
      FROM audit.events
      WHERE aggregate_type = 'task'
        AND occurred_at BETWEEN ${sprint?.startedAt ?? new Date(0)}
            AND ${sprint?.completedAt ?? new Date()}
    `)
    const tcRow = (taskRows as unknown as Array<{ completed_count: number; failed_count: number }>)[0]

    const verifierRows = await this.db.execute(dSQL`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'TaskVerified' AND payload->>'outcome' = 'pass')::int AS pass_count,
        COUNT(*) FILTER (WHERE event_type = 'TaskVerified')::int AS total_count
      FROM audit.events
      WHERE occurred_at BETWEEN ${sprint?.startedAt ?? new Date(0)}
        AND ${sprint?.completedAt ?? new Date()}
    `)
    const vRow = (verifierRows as unknown as Array<{ pass_count: number; total_count: number }>)[0]
    const passRate = vRow && vRow.total_count > 0
      ? Math.round((Number(vRow.pass_count) / Number(vRow.total_count)) * 100)
      : 0

    const defectRows = await this.db.execute(dSQL`
      SELECT COUNT(*)::int AS defect_count
      FROM audit.events
      WHERE event_type = 'DefectRaised'
        AND occurred_at BETWEEN ${sprint?.startedAt ?? new Date(0)}
            AND ${sprint?.completedAt ?? new Date()}
    `)
    const dRow = (defectRows as unknown as Array<{ defect_count: number }>)[0]

    return {
      sprintId,
      startedAt,
      completedAt,
      totalCostUsdMicros,
      completedTaskCount: Number(tcRow?.completed_count ?? 0),
      failedTaskCount: Number(tcRow?.failed_count ?? 0),
      capabilityDenialCount: Number(capDenials?.total ?? 0),
      escalationCount: Number(escalation?.escalated_count ?? 0),
      defectCount: Number(dRow?.defect_count ?? 0),
      verifierPassRatePct: passRate,
      cycleTimeP50Ms: cycle?.p50_ms ?? null,
      cycleTimeP90Ms: cycle?.p90_ms ?? null,
      rawMetrics,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapAnalystProposalToProposal(p: RetroAnalystProposal, sprintId: string): Proposal {
  // Ensure exactly one dominant — if model returned zero, mark the first.
  const layers = p.layers.map((l) => ({ ...l }))
  const dominantCount = layers.filter((l) => l.is_dominant).length
  if (dominantCount === 0 && layers[0]) layers[0].is_dominant = true
  if (dominantCount > 1) {
    let kept = false
    for (const l of layers) {
      if (l.is_dominant) {
        if (kept) l.is_dominant = false
        else kept = true
      }
    }
  }

  const proposal: Proposal = {
    proposal_code: p.proposal_code,
    title: p.title,
    hypothesis: p.hypothesis,
    expected_impact: {
      metric_key: p.expected_impact.metric_key,
      direction: p.expected_impact.direction,
      pct_points: p.expected_impact.pct_points,
    },
    rollback_path: p.rollback_path,
    layers,
    evidence_refs: [],
    confidence_score: p.confidence_score,
    is_global: false,
    applies_to_sprint_id: sprintId,
  }
  if (p.current_value !== undefined) proposal.current_value = p.current_value
  if (p.proposed_value !== undefined) proposal.proposed_value = p.proposed_value
  return proposal
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRetroService(
  db: DB,
  eventStore: EventStore,
  authority: ICapabilityAuthority,
  personaLoader: PersonaLoader,
  installId: string,
  options: RetroServiceOptions = {},
): RetroService {
  return new DefaultRetroService(db, eventStore, authority, personaLoader, installId, options)
}
