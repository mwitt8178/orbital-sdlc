/**
 * retros/proposals.ts - The ProposalService.
 *
 * Per TRD-10 v0.1 §6.4, §6.5, §11.2, §11.4 and Phase 5B brief.
 *
 * Owns the proposal lifecycle:
 *
 *   pending -> approved -> merged
 *           -> rejected
 *           -> deferred
 *           -> merged    -> rolled_back
 *
 * Approval triggers a real `git commit` against the AgentOrgRepo, inserts a
 * `system_versions` row, opens an outcome window, and emits
 * RetroApproved + SystemVersionShipped (parent_event_id-linked).
 *
 * Rejection and deferral are pure DB updates + event emission.
 *
 * Rollback creates a NEW system_versions row (immutable history) and updates
 * the originating proposal's status to 'rolled_back'.
 */

import { uuidv7 } from 'uuidv7'
import { eq, and, sql as dSQL } from 'drizzle-orm'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { logger } from '../config/logger.js'
import {
  retroReports,
  retroProposals,
  retroProposalLayers,
  retroOutcomes,
  systemVersions,
  systemVersionDiffs,
  type RetroProposalRow,
} from '../db/schema/retros.js'
import type { AgentOrgRepo } from './agent-org.js'
import {
  RetroApprovedPayloadV1,
  RetroRejectedPayloadV1,
  RetroDeferredPayloadV1,
  RetroRolledBackPayloadV1,
  SystemVersionShippedPayloadV1,
  type ProposalLayer,
} from './types.js'

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  retroProposalId: string
  prRef: string
  mergedSystemVersionId: string
  gitSha: string
  versionNumber: string
}

export interface RollbackResult {
  newSystemVersionId: string
  gitTag: string
  gitSha: string
  impactPreview: {
    affectedFiles: string[]
    dependentProposalIds: string[]
  }
}

// Sentinel UUID for local-install / legacy callers that don't pass tenantId.
const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'

export interface ProposalService {
  approve(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts?: { trace_id?: string; clientIdempotencyKey?: string },
    tenantId?: string,
  ): Promise<ApprovalResult>

  reject(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts?: { trace_id?: string },
    tenantId?: string,
  ): Promise<{ retroProposalId: string }>

  defer(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts?: { trace_id?: string; deferUntilSprintId?: string },
    tenantId?: string,
  ): Promise<{ retroProposalId: string }>

  rollback(
    rolledBackSystemVersionId: string,
    rationale: string,
    userId: string,
    opts?: { trace_id?: string; confirmWithDependents?: boolean },
    tenantId?: string,
  ): Promise<RollbackResult>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const USER_ACTOR_FACTORY = (userId: string, installId: string): Actor => ({
  type: 'user',
  user_id: userId,
  install_id: installId,
})

export class DefaultProposalService implements ProposalService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly agentOrg: AgentOrgRepo,
    private readonly installId: string,
  ) {}

  // -------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------

  async approve(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts: { trace_id?: string; clientIdempotencyKey?: string } = {},
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ApprovalResult> {
    if (!rationale || rationale.trim().length === 0) {
      throw new OrbitalError(
        'VALIDATION_REQUIRED_FIELD_MISSING',
        'rationale is required (Primitives §14)',
      )
    }

    const proposal = await this.getProposalOrThrow(retroProposalId, tenantId)
    if (proposal.status !== 'pending') {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `proposal ${retroProposalId} is in state ${proposal.status}; cannot approve`,
      )
    }

    // Fetch the dominant layer (one row).
    const layerRows = await this.db
      .select()
      .from(retroProposalLayers)
      .where(eq(retroProposalLayers.retroProposalId, retroProposalId))
    if (layerRows.length === 0) {
      throw new OrbitalError(
        'VALIDATION_PROPOSAL_MISSING_DOMINANT_LAYER',
        `proposal ${retroProposalId} has no layer rows`,
      )
    }
    const dominant = layerRows.find((l) => l.isDominant) ?? layerRows[0]!

    // Make sure the agent-org repo exists.
    if (!(await this.agentOrg.isInitialized())) {
      await this.agentOrg.init()
    }

    // Determine the file content to commit.
    // Order of preference:
    //  1. proposal.proposed_value if string
    //  2. proposal.diff_preview from layer if present
    //  3. a marker file describing the proposal (proposal_code + title)
    //
    // In production the retro persona attaches the new file content; in tests
    // the synth helper sets proposed_value to a string. Either way, this
    // method writes a real file and produces a real commit.
    const fileContent = this.deriveFileContent(proposal, dominant.diffPreview)

    const traceId = opts.trace_id ?? uuidv7()
    const branchName = `retro/${retroProposalId}`
    const author = `Orbital Retro <retro@orbital.local>`
    const commitMessage = this.buildCommitMessage(proposal, dominant.layer as ProposalLayer)

    let parentSha: string
    try {
      parentSha = await this.agentOrg.headSha()
    } catch {
      // Fresh repo; init and use HEAD.
      await this.agentOrg.init()
      parentSha = await this.agentOrg.headSha()
    }

    let commitSha: string
    try {
      commitSha = await this.agentOrg.commit(
        dominant.targetPath,
        fileContent,
        commitMessage,
        author,
      )
    } catch (err) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `Git commit for proposal ${retroProposalId} failed: ${(err as Error).message}`,
      )
    }

    const versionNumber = await this.deriveVersionNumber(dominant.layer as ProposalLayer)
    const gitTag = versionNumber
    try {
      await this.agentOrg.tag(gitTag, commitMessage)
    } catch (err) {
      // Tag failure is recoverable but we should log; the commit is what
      // matters for system_versions.git_sha.
      logger.warn(
        { err, gitTag, commitSha },
        'ProposalService.approve: tag creation failed; continuing with commit SHA',
      )
    }

    // Insert the system_versions row.
    const systemVersionId = uuidv7()
    const createdEventId = uuidv7()
    const parentVersionRows = await this.db
      .select()
      .from(systemVersions)
      .where(eq(systemVersions.gitSha, parentSha))
      .limit(1)
    const parentVersionId = parentVersionRows[0]?.systemVersionId ?? null

    await this.db.insert(systemVersions).values({
      systemVersionId,
      versionNumber,
      parentSystemVersionId: parentVersionId,
      gitTag,
      gitSha: commitSha,
      shippedBy: userId,
      isRollback: false,
      retroReportId: proposal.retroReportId,
      notes: rationale,
      createdEventId,
    })

    // Insert system_version_diffs rows (one per touched file).
    const filesChanged = await this.agentOrg.filesChanged(commitSha)
    const unifiedDiff = await this.agentOrg.unifiedDiff(commitSha)
    const diffRowsBuilder: Array<{
      systemVersionDiffId: string
      systemVersionId: string
      retroProposalId: string
      layer: string
      filePath: string
      changeType: 'added' | 'modified' | 'deleted'
      unifiedDiff: string
    }> = []
    for (const file of filesChanged) {
      diffRowsBuilder.push({
        systemVersionDiffId: uuidv7(),
        systemVersionId,
        retroProposalId,
        layer: dominant.layer,
        filePath: file,
        // Best-effort: 'modified' is a safe default; init scaffold made the
        // file exist so 'added' is possible too. We use 'modified' uniformly
        // for now; the unified_diff carries the precise truth.
        changeType: 'modified',
        unifiedDiff,
      })
    }
    if (diffRowsBuilder.length > 0) {
      await this.db.insert(systemVersionDiffs).values(diffRowsBuilder)
    }

    // Update the proposal: pending -> merged.
    const decidedAt = new Date()
    await this.db
      .update(retroProposals)
      .set({
        status: 'merged',
        decidedBy: userId,
        decidedAt,
        decisionRationale: rationale,
        prRef: branchName,
        mergedSystemVersionId: systemVersionId,
      })
      .where(eq(retroProposals.retroProposalId, retroProposalId))

    // Bump the report's approved_count and ensure status='reviewing'.
    await this.db
      .update(retroReports)
      .set({
        approvedCount: dSQL`${retroReports.approvedCount} + 1`,
        status: dSQL`CASE WHEN ${retroReports.status} = 'ready' THEN 'reviewing' ELSE ${retroReports.status} END`,
      })
      .where(eq(retroReports.retroReportId, proposal.retroReportId))

    // Open an outcome window.
    const outcomeId = uuidv7()
    await this.db.insert(retroOutcomes).values({
      retroOutcomeId: outcomeId,
      retroProposalId,
      systemVersionId,
      metricKey: proposal.expectedImpactMetric,
      expectedDirection: proposal.expectedImpactDirection,
      expectedPctPoints: proposal.expectedImpactPctPoints,
      windowSprintCount: 2,
      toleranceBand: 500,
    })

    // Emit RetroApproved.
    const userActor = USER_ACTOR_FACTORY(userId, this.installId)
    const approvedPayload = RetroApprovedPayloadV1.parse({
      retro_proposal_id: retroProposalId,
      decided_by_user_id: userId,
      decision_rationale: rationale,
      pr_ref: branchName,
      merged_system_version_id: systemVersionId,
      shipped_git_sha: commitSha,
      schema_version: 1,
    })
    const approvedEv: EventInput = {
      aggregate_id: retroProposalId,
      aggregate_type: 'retro',
      event_type: 'RetroApproved',
      payload: approvedPayload,
      actor: userActor,
      trace_id: traceId,
      occurred_at: decidedAt.toISOString(),
      schema_version: 1,
    }
    const approvedEnvelope = await this.eventStore.append(approvedEv)

    // Emit SystemVersionShipped (linked via parent_event_id).
    const shippedPayload = SystemVersionShippedPayloadV1.parse({
      system_version_id: systemVersionId,
      version_number: versionNumber,
      parent_system_version_id: parentVersionId,
      git_tag: gitTag,
      git_sha: commitSha,
      retro_report_id: proposal.retroReportId,
      proposal_ids_merged: [retroProposalId],
      is_rollback: false,
      rolled_back_version_id: null,
      schema_version: 1,
    })
    const shippedEv: EventInput = {
      aggregate_id: systemVersionId,
      aggregate_type: 'system_version',
      event_type: 'SystemVersionShipped',
      payload: shippedPayload,
      actor: userActor,
      trace_id: traceId,
      parent_event_id: approvedEnvelope.event_id,
      occurred_at: decidedAt.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(shippedEv)

    logger.info(
      {
        retroProposalId,
        systemVersionId,
        gitSha: commitSha,
        versionNumber,
      },
      'ProposalService.approve: merged',
    )

    return {
      retroProposalId,
      prRef: branchName,
      mergedSystemVersionId: systemVersionId,
      gitSha: commitSha,
      versionNumber,
    }
  }

  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------

  async reject(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts: { trace_id?: string } = {},
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ retroProposalId: string }> {
    if (!rationale || rationale.trim().length === 0) {
      throw new OrbitalError(
        'VALIDATION_REQUIRED_FIELD_MISSING',
        'rationale is required',
      )
    }

    const proposal = await this.getProposalOrThrow(retroProposalId, tenantId)
    if (proposal.status !== 'pending') {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `proposal ${retroProposalId} is in state ${proposal.status}; cannot reject`,
      )
    }

    const decidedAt = new Date()
    await this.db
      .update(retroProposals)
      .set({
        status: 'rejected',
        decidedBy: userId,
        decidedAt,
        decisionRationale: rationale,
      })
      .where(eq(retroProposals.retroProposalId, retroProposalId))

    await this.db
      .update(retroReports)
      .set({
        rejectedCount: dSQL`${retroReports.rejectedCount} + 1`,
        status: dSQL`CASE WHEN ${retroReports.status} = 'ready' THEN 'reviewing' ELSE ${retroReports.status} END`,
      })
      .where(eq(retroReports.retroReportId, proposal.retroReportId))

    const traceId = opts.trace_id ?? uuidv7()
    const userActor = USER_ACTOR_FACTORY(userId, this.installId)
    const payload = RetroRejectedPayloadV1.parse({
      retro_proposal_id: retroProposalId,
      decided_by_user_id: userId,
      decision_rationale: rationale,
      schema_version: 1,
    })
    await this.eventStore.append({
      aggregate_id: retroProposalId,
      aggregate_type: 'retro',
      event_type: 'RetroRejected',
      payload,
      actor: userActor,
      trace_id: traceId,
      occurred_at: decidedAt.toISOString(),
      schema_version: 1,
    })

    return { retroProposalId }
  }

  // -------------------------------------------------------------------------
  // defer
  // -------------------------------------------------------------------------

  async defer(
    retroProposalId: string,
    rationale: string,
    userId: string,
    opts: { trace_id?: string; deferUntilSprintId?: string } = {},
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ retroProposalId: string }> {
    if (!rationale || rationale.trim().length === 0) {
      throw new OrbitalError(
        'VALIDATION_REQUIRED_FIELD_MISSING',
        'rationale is required',
      )
    }

    const proposal = await this.getProposalOrThrow(retroProposalId, tenantId)
    if (proposal.status !== 'pending') {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `proposal ${retroProposalId} is in state ${proposal.status}; cannot defer`,
      )
    }

    const decidedAt = new Date()
    await this.db
      .update(retroProposals)
      .set({
        status: 'deferred',
        decidedBy: userId,
        decidedAt,
        decisionRationale: rationale,
      })
      .where(eq(retroProposals.retroProposalId, retroProposalId))

    await this.db
      .update(retroReports)
      .set({
        deferredCount: dSQL`${retroReports.deferredCount} + 1`,
        status: dSQL`CASE WHEN ${retroReports.status} = 'ready' THEN 'reviewing' ELSE ${retroReports.status} END`,
      })
      .where(eq(retroReports.retroReportId, proposal.retroReportId))

    const traceId = opts.trace_id ?? uuidv7()
    const userActor = USER_ACTOR_FACTORY(userId, this.installId)
    const payloadInput: Record<string, unknown> = {
      retro_proposal_id: retroProposalId,
      decided_by_user_id: userId,
      decision_rationale: rationale,
      schema_version: 1,
    }
    if (opts.deferUntilSprintId) {
      payloadInput['defer_until_retro_after_sprint_id'] = opts.deferUntilSprintId
    }
    const payload = RetroDeferredPayloadV1.parse(payloadInput)
    await this.eventStore.append({
      aggregate_id: retroProposalId,
      aggregate_type: 'retro',
      event_type: 'RetroDeferred',
      payload,
      actor: userActor,
      trace_id: traceId,
      occurred_at: decidedAt.toISOString(),
      schema_version: 1,
    })

    return { retroProposalId }
  }

  // -------------------------------------------------------------------------
  // rollback
  // -------------------------------------------------------------------------

  async rollback(
    rolledBackSystemVersionId: string,
    rationale: string,
    userId: string,
    opts: { trace_id?: string; confirmWithDependents?: boolean } = {},
    tenantId: string = SENTINEL_TENANT,
  ): Promise<RollbackResult> {
    if (!rationale || rationale.trim().length === 0) {
      throw new OrbitalError(
        'VALIDATION_REQUIRED_FIELD_MISSING',
        'rationale is required',
      )
    }

    const versionRows = await this.db
      .select()
      .from(systemVersions)
      .where(eq(systemVersions.systemVersionId, rolledBackSystemVersionId))
      .limit(1)
    if (versionRows.length === 0) {
      throw new OrbitalError(
        'NOT_FOUND_SYSTEM_VERSION',
        `version ${rolledBackSystemVersionId} not found`,
      )
    }
    const targetVersion = versionRows[0]!

    // Compute impact preview: affected files + dependent proposals.
    const affectedDiffRows = await this.db
      .select()
      .from(systemVersionDiffs)
      .where(eq(systemVersionDiffs.systemVersionId, rolledBackSystemVersionId))
    const affectedFiles = affectedDiffRows.map((r) => r.filePath)

    // Dependent proposals: system_versions OTHER THAN the target whose diffs
    // touch any of the same files AND were shipped strictly after the target.
    // We compare by the target's row id rather than recomputing from the JS
    // Date because timestamp round-tripping through JS loses precision.
    let dependentProposalIds: string[] = []
    if (affectedFiles.length > 0) {
      const fileList = affectedFiles.map((f) => `'${f.replace(/'/g, "''")}'`).join(',')
      const dependentRows = await this.db.execute(dSQL`
        WITH target AS (
          SELECT shipped_at FROM system_versions
          WHERE system_version_id = ${rolledBackSystemVersionId}::uuid
        )
        SELECT DISTINCT d.retro_proposal_id::text AS retro_proposal_id
        FROM system_version_diffs d
        JOIN system_versions v ON v.system_version_id = d.system_version_id
        CROSS JOIN target
        WHERE d.file_path IN (${dSQL.raw(fileList)})
          AND v.shipped_at > target.shipped_at
          AND v.system_version_id != ${rolledBackSystemVersionId}::uuid
          AND d.retro_proposal_id IS NOT NULL
      `)
      const drows = dependentRows as unknown as Array<{ retro_proposal_id: string }>
      dependentProposalIds = drows.map((r) => r.retro_proposal_id).filter((s) => s.length > 0)
    }

    if (dependentProposalIds.length > 0 && !opts.confirmWithDependents) {
      throw new OrbitalError(
        'CONFLICT_ROLLBACK_HAS_DEPENDENTS',
        `rollback of ${rolledBackSystemVersionId} would affect ${dependentProposalIds.length} dependent proposals; set confirmWithDependents=true to proceed`,
        {
          dependent_proposal_ids: dependentProposalIds,
          affected_files: affectedFiles,
        },
      )
    }

    // Make sure the agent-org repo exists.
    if (!(await this.agentOrg.isInitialized())) {
      await this.agentOrg.init()
    }

    // Reset the working tree to the parent SHA. This is destructive but
    // intentional per TRD-10 §11.4 (option B; we do the simple reset rather
    // than a `git revert` because the in-process Git repo is single-writer
    // and a hard reset is atomic).
    const parentSha = await this.agentOrg.parentOf(targetVersion.gitSha)
    if (!parentSha) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `version ${rolledBackSystemVersionId} has no parent commit; cannot rollback to a pre-genesis state`,
      )
    }
    await this.agentOrg.reset(parentSha)

    // Produce a marker commit so the rollback itself is a new SHA.
    const markerPath = 'VERSION'
    const newVersionNumber = `${targetVersion.versionNumber}-rollback-${Date.now()}`
    const markerContent = `${newVersionNumber}\n`
    const newSha = await this.agentOrg.commit(
      markerPath,
      markerContent,
      `rollback: revert ${targetVersion.gitTag} (${targetVersion.versionNumber})`,
      `Orbital Retro <retro@orbital.local>`,
    )
    const newGitTag = `${newVersionNumber}`
    try {
      await this.agentOrg.tag(newGitTag, `Rollback of ${targetVersion.gitTag}`)
    } catch (err) {
      logger.warn({ err, newGitTag }, 'rollback tag creation failed; continuing')
    }

    const newSystemVersionId = uuidv7()
    const createdEventId = uuidv7()
    await this.db.insert(systemVersions).values({
      systemVersionId: newSystemVersionId,
      versionNumber: newVersionNumber,
      parentSystemVersionId: rolledBackSystemVersionId,
      gitTag: newGitTag,
      gitSha: newSha,
      shippedBy: userId,
      isRollback: true,
      rolledBackVersionId: rolledBackSystemVersionId,
      retroReportId: targetVersion.retroReportId,
      notes: rationale,
      createdEventId,
    })

    // Update the originating proposal(s) to 'rolled_back' (best-effort).
    // A version can pin >=1 proposals; we update all that referenced this
    // mergedSystemVersionId.
    const proposalsToUpdate = await this.db
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.mergedSystemVersionId, rolledBackSystemVersionId))
    let rolledBackProposalId: string | null = null
    for (const p of proposalsToUpdate) {
      await this.db
        .update(retroProposals)
        .set({ status: 'rolled_back' })
        .where(eq(retroProposals.retroProposalId, p.retroProposalId))
      if (rolledBackProposalId === null) rolledBackProposalId = p.retroProposalId
    }

    // Emit RetroRolledBack + SystemVersionShipped (linked).
    const traceId = opts.trace_id ?? uuidv7()
    const userActor = USER_ACTOR_FACTORY(userId, this.installId)
    const occurredAt = new Date()
    const rolledBackPayload = RetroRolledBackPayloadV1.parse({
      rolled_back_proposal_id: rolledBackProposalId,
      rolled_back_system_version_id: rolledBackSystemVersionId,
      new_system_version_id: newSystemVersionId,
      user_id: userId,
      rationale,
      impact_preview: {
        affected_files: affectedFiles,
        dependent_proposal_ids: dependentProposalIds,
      },
      schema_version: 1,
    })
    const rolledBackEnvelope = await this.eventStore.append({
      aggregate_id: rolledBackSystemVersionId,
      aggregate_type: 'system_version',
      event_type: 'RetroRolledBack',
      payload: rolledBackPayload,
      actor: userActor,
      trace_id: traceId,
      occurred_at: occurredAt.toISOString(),
      schema_version: 1,
    })

    const shippedPayload = SystemVersionShippedPayloadV1.parse({
      system_version_id: newSystemVersionId,
      version_number: newVersionNumber,
      parent_system_version_id: rolledBackSystemVersionId,
      git_tag: newGitTag,
      git_sha: newSha,
      retro_report_id: targetVersion.retroReportId,
      proposal_ids_merged: [],
      is_rollback: true,
      rolled_back_version_id: rolledBackSystemVersionId,
      schema_version: 1,
    })
    await this.eventStore.append({
      aggregate_id: newSystemVersionId,
      aggregate_type: 'system_version',
      event_type: 'SystemVersionShipped',
      payload: shippedPayload,
      actor: userActor,
      trace_id: traceId,
      parent_event_id: rolledBackEnvelope.event_id,
      occurred_at: occurredAt.toISOString(),
      schema_version: 1,
    })

    logger.info(
      {
        rolledBackSystemVersionId,
        newSystemVersionId,
        newSha,
      },
      'ProposalService.rollback: complete',
    )

    return {
      newSystemVersionId,
      gitTag: newGitTag,
      gitSha: newSha,
      impactPreview: {
        affectedFiles,
        dependentProposalIds,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async getProposalOrThrow(
    retroProposalId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<RetroProposalRow> {
    const rows = await this.db
      .select()
      .from(retroProposals)
      .where(
        and(
          eq(retroProposals.retroProposalId, retroProposalId),
          eq(retroProposals.tenantId, tenantId),
        ),
      )
      .limit(1)
    const p = rows[0]
    if (!p) {
      throw new OrbitalError(
        'NOT_FOUND_RETRO_PROPOSAL',
        `proposal ${retroProposalId} not found`,
      )
    }
    return p
  }

  private deriveFileContent(
    proposal: RetroProposalRow,
    diffPreview: string | null,
  ): string {
    // 1. proposed_value as string
    if (typeof proposal.proposedValue === 'string') {
      return proposal.proposedValue
    }
    if (proposal.proposedValue !== null && typeof proposal.proposedValue === 'object') {
      // Deserialize jsonb to a deterministic string.
      return JSON.stringify(proposal.proposedValue, null, 2) + '\n'
    }
    // 2. diff_preview from layer
    if (typeof diffPreview === 'string' && diffPreview.length > 0) {
      return diffPreview
    }
    // 3. marker file with proposal metadata
    return [
      `# ${proposal.title}`,
      ``,
      `Proposal code: ${proposal.proposalCode}`,
      `Hypothesis: ${proposal.hypothesis}`,
      `Rollback path: ${proposal.rollbackPath}`,
      ``,
    ].join('\n')
  }

  private buildCommitMessage(proposal: RetroProposalRow, layer: ProposalLayer): string {
    return [
      `retro(${layer}): ${proposal.title}`,
      ``,
      `Proposal: ${proposal.proposalCode}`,
      `Hypothesis: ${proposal.hypothesis.split('\n')[0]}`,
      `Expected impact: ${proposal.expectedImpactDirection} ${proposal.expectedImpactPctPoints} bp on ${proposal.expectedImpactMetric}`,
      `Rollback: ${proposal.rollbackPath}`,
    ].join('\n')
  }

  /**
   * Determine the next semver-style version number. We bump minor for
   * persona/orchestrator changes and patch for everything else (per TRD-10
   * §11.2). The version number embeds a high-resolution monotonic suffix to
   * guarantee uniqueness across concurrent approvals (avoiding race against
   * the version_number unique constraint when two tests insert in parallel).
   */
  private async deriveVersionNumber(layer: ProposalLayer): Promise<string> {
    const heavyBump = layer === 'persona' || layer === 'orchestrator'
    const bump = heavyBump ? 'minor' : 'patch'
    // Embed a UUIDv7 fragment + nanosecond-resolution counter to defeat
    // collisions during parallel test runs. The semver prefix is informative
    // only; the unique segment is the suffix.
    const stamp = `${process.hrtime.bigint().toString(36)}-${uuidv7().slice(0, 8)}`
    return `org-v0.${heavyBump ? 1 : 0}.${heavyBump ? 0 : 1}-${bump}-${stamp}`
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProposalService(
  db: DB,
  eventStore: EventStore,
  agentOrg: AgentOrgRepo,
  installId: string,
): ProposalService {
  return new DefaultProposalService(db, eventStore, agentOrg, installId)
}
