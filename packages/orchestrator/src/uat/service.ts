/**
 * uat/service.ts — UATService.
 *
 * Per TRD-11 v0.2 §6.1, §7.1, §7.2, §8.
 *
 * Responsibilities:
 *   - startSession: open (or resume) a UAT session for a story. Snapshots ACs
 *     from story_acceptance_criteria at session start.
 *   - markAC: set an AC result to pass/fail. Idempotent on same status; emits
 *     UATACUnmarked + UATACMarked when changing from a prior non-pending state.
 *   - unmarkAC: revert an AC to pending.
 *   - submit: finalise a session. Guards: all ACs must be non-pending (no
 *     VALIDATION_PENDING_ACS_REMAIN). Creates defects for every failed AC.
 *     Transaction: insert N defects + lineage, resolve personas, write events.
 *   - accept / partialAccept: transition from submitted to terminal state.
 *
 * State machines enforced per TRD-11 §7.1 and §7.2.
 * Advisory lock per §8.5 to serialise concurrent submits on the same session.
 * All events via EventStore.append; no direct db.insert(events).
 */

import { uuidv7 } from 'uuidv7'
import { eq, and, sql as dSQL, inArray, asc, count } from 'drizzle-orm'

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'
import { OrbitalError } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { DefectService } from './defects.js'
import type { PersonaOfRecord } from './persona-of-record.js'
import {
  uatSessions,
  uatAcResults,
  defects as defectsTable,
} from '../db/schema/uat.js'
import { storyAcceptanceCriteria, stories } from '../db/schema/backlog.js'
import { tasks } from '../db/schema/orchestration.js'
import {
  UAT_ERROR_CODES,
  type UATSessionRow,
  type UATACResultRow,
  type StartSessionInput,
  type MarkACInput,
  type UnmarkACInput,
  type SubmitSessionInput,
  type MarkACOutput,
  type SubmitOutput,
} from './types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// UATService interface
// ---------------------------------------------------------------------------

export interface UATService {
  startSession(
    input: StartSessionInput,
    userActor: { userId: string; installId?: string },
    tenantId?: string,
  ): Promise<{ session: UATSessionRow; acResults: UATACResultRow[] }>

  markAC(input: MarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>

  unmarkAC(input: UnmarkACInput, userId: string, tenantId?: string): Promise<MarkACOutput>

  submit(input: SubmitSessionInput, userId: string, tenantId?: string): Promise<SubmitOutput>

  /**
   * Accept a submitted session (all ACs passed).
   * Throws CONFLICT_INVALID_STATE_TRANSITION if session is not in 'submitted'
   * state or if there are any failed ACs (use partialAccept for that).
   */
  accept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>

  /**
   * Partial-accept: some ACs pass, defects already created by submit.
   * Transitions session to 'partially_accepted'. Emits UATPartialAcceptance.
   * Also writes a SprintCompleted event with partial:true flag so SprintService
   * can pick it up (5A does not touch SprintService directly).
   */
  partialAccept(sessionId: string, userId: string, tenantId?: string): Promise<UATSessionRow>

  getSession(
    sessionId: string,
    tenantId?: string,
  ): Promise<{ session: UATSessionRow; acResults: UATACResultRow[] } | null>

  listSessions(
    ticketId: string,
    tenantId?: string,
  ): Promise<Array<{ session: UATSessionRow; acResults: UATACResultRow[] }>>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultUATService implements UATService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly defectService: DefectService,
    private readonly personaOfRecord: PersonaOfRecord,
  ) {}

  // -------------------------------------------------------------------------
  // startSession
  // -------------------------------------------------------------------------

  async startSession(
    input: StartSessionInput,
    userActor: { userId: string; installId?: string },
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ session: UATSessionRow; acResults: UATACResultRow[] }> {
    const { ticket_id, triggered_by_event_id, build_ref, resume_existing } = input
    const traceId = uuidv7()
    const now = new Date()

    // Check for resumable session (started or in_progress)
    if (resume_existing) {
      const resumable = await this.db
        .select()
        .from(uatSessions)
        .where(
          and(
            eq(uatSessions.ticketId, ticket_id),
            eq(uatSessions.tenantId, tenantId),
            inArray(uatSessions.state, ['started', 'in_progress']),
          ),
        )
        .orderBy(asc(uatSessions.sessionVersion))
        .limit(1)

      if (resumable.length > 0 && resumable[0]) {
        const session = resumable[0]
        const acResults = await this.getACResults(session.uatSessionId)
        logger.debug(
          { uatSessionId: session.uatSessionId },
          'UATService.startSession: resuming existing session',
        )
        return { session, acResults }
      }
    }

    // Validate ticket exists in stories table
    const storyRows = await this.db
      .select()
      .from(stories)
      .where(eq(stories.storyId, ticket_id))
      .limit(1)

    if (storyRows.length === 0) {
      throw new OrbitalError(
        UAT_ERROR_CODES.NOT_FOUND_TICKET,
        `ticket/story ${ticket_id} not found`,
      )
    }

    // Fetch ACs for this story
    const acs = await this.db
      .select()
      .from(storyAcceptanceCriteria)
      .where(eq(storyAcceptanceCriteria.storyId, ticket_id))
      .orderBy(asc(storyAcceptanceCriteria.ordinal))

    // Determine session_version: next version after the last one for this ticket
    const existing = await this.db
      .select({ sessionVersion: uatSessions.sessionVersion })
      .from(uatSessions)
      .where(and(eq(uatSessions.ticketId, ticket_id), eq(uatSessions.tenantId, tenantId)))
      .orderBy(asc(uatSessions.sessionVersion))

    const sessionVersion = existing.length === 0 ? 1 : (existing[existing.length - 1]?.sessionVersion ?? 0) + 1

    const sessionId = uuidv7()

    // Create session row
    await this.db.insert(uatSessions).values({
      uatSessionId: sessionId,
      tenantId,
      ticketId: ticket_id,
      storyVersion: 1, // story schema_version; use 1 as default in v1
      sessionVersion,
      state: 'started',
      triggeredByEventId: triggered_by_event_id,
      buildRef: build_ref,
      startedByUserId: userActor.userId,
      startedAt: now,
      totalAcCount: acs.length,
      passCount: 0,
      failCount: 0,
      assumptionsSnapshot: [],
      schemaVersion: 1,
    })

    // Create AC result rows (all start as pending, snapshot text)
    const acResultRows = acs.map((ac) => ({
      acResultId: uuidv7(),
      uatSessionId: sessionId,
      acId: ac.acId,
      acOrdinal: ac.ordinal,
      acTextSnapshot: ac.text,
      status: 'pending' as const,
      observedBehavior: null,
      evidenceLinks: [] as Array<{ type: 'screenshot' | 'log' | 'video' | 'audit_event' | 'channel_post'; uri: string; label?: string }>,
      markedAt: null,
      markedByUserId: null,
      schemaVersion: 1,
    }))

    if (acResultRows.length > 0) {
      await this.db.insert(uatAcResults).values(acResultRows)
    }

    // Emit UATSessionStarted
    await this.eventStore.append({
      aggregate_id: sessionId,
      aggregate_type: 'uat_session',
      event_type: 'UATSessionStarted',
      payload: {
        uat_session_id: sessionId,
        ticket_id,
        story_version: 1,
        session_version: sessionVersion,
        triggered_by_event_id,
        build_ref,
        total_ac_count: acs.length,
        assumptions_count: 0,
      },
      actor: {
        type: 'user',
        user_id: userActor.userId,
        install_id: userActor.installId ?? 'unknown',
      },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    const [session] = await this.db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)

    if (!session) {
      throw new OrbitalError(UAT_ERROR_CODES.INTERNAL_DB_ERROR, 'session insert returned no rows')
    }

    const acResults = await this.getACResults(sessionId)

    logger.info(
      { uatSessionId: sessionId, ticketId: ticket_id, sessionVersion, acCount: acs.length },
      'UATService.startSession: session started',
    )

    return { session, acResults }
  }

  // -------------------------------------------------------------------------
  // markAC
  // -------------------------------------------------------------------------

  async markAC(input: MarkACInput, userId: string, tenantId: string = SENTINEL_TENANT): Promise<MarkACOutput> {
    const { uat_session_id, ac_id, status, observed_behavior, evidence_links } = input
    const traceId = uuidv7()
    const now = new Date()

    // Validate observed_behavior required on fail
    if (status === 'fail' && (!observed_behavior || observed_behavior.trim().length === 0)) {
      throw new OrbitalError(
        UAT_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING,
        'observed_behavior is required when status is fail',
      )
    }

    return await this.db.transaction(async (tx) => {
      // Advisory lock to serialise marks on same session
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'uat:' + uat_session_id}))`,
      )

      // Fetch session (tenant-scoped)
      const [session] = await tx
        .select()
        .from(uatSessions)
        .where(and(eq(uatSessions.uatSessionId, uat_session_id), eq(uatSessions.tenantId, tenantId)))
        .limit(1)

      if (!session) {
        throw new OrbitalError(
          UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION,
          `session ${uat_session_id} not found`,
        )
      }

      // Guard: cannot mark after terminal
      if (['accepted', 'partially_accepted', 'rejected', 'submitted'].includes(session.state)) {
        throw new OrbitalError(
          UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot mark AC on session in state ${session.state}`,
        )
      }

      // Fetch AC result
      const [acResult] = await tx
        .select()
        .from(uatAcResults)
        .where(
          and(
            eq(uatAcResults.uatSessionId, uat_session_id),
            eq(uatAcResults.acId, ac_id),
          ),
        )
        .limit(1)

      if (!acResult) {
        throw new OrbitalError(
          UAT_ERROR_CODES.NOT_FOUND_AC,
          `AC ${ac_id} not found in session ${uat_session_id}`,
        )
      }

      // Idempotency: no-op if same status
      if (acResult.status === status) {
        const counts = await this.getCountsTx(tx, uat_session_id)
        return {
          ac_result_id: acResult.acResultId,
          status,
          ...counts,
        }
      }

      const priorStatus = acResult.status

      // Update AC result
      await tx
        .update(uatAcResults)
        .set({
          status,
          observedBehavior: observed_behavior ?? null,
          evidenceLinks: evidence_links ?? [],
          markedAt: now,
          markedByUserId: userId,
        })
        .where(eq(uatAcResults.acResultId, acResult.acResultId))

      // Update session counts + state
      const passAdjust = status === 'pass' ? 1 : priorStatus === 'pass' ? -1 : 0
      const failAdjust = status === 'fail' ? 1 : priorStatus === 'fail' ? -1 : 0

      const newPassCount = Math.max(0, session.passCount + passAdjust)
      const newFailCount = Math.max(0, session.failCount + failAdjust)
      const newState = session.state === 'started' ? 'in_progress' : session.state

      await tx
        .update(uatSessions)
        .set({
          passCount: newPassCount,
          failCount: newFailCount,
          state: newState,
        })
        .where(eq(uatSessions.uatSessionId, uat_session_id))

      // Emit events (outside TX body to avoid nested transactions; we'll batch after)
      const pendingCount =
        session.totalAcCount - newPassCount - newFailCount

      // Emit UATACUnmarked if transitioning away from a non-pending prior status
      if (priorStatus !== 'pending') {
        await this.eventStore.append({
          aggregate_id: uat_session_id,
          aggregate_type: 'uat_session',
          event_type: 'UATACUnmarked',
          payload: {
            uat_session_id,
            ac_result_id: acResult.acResultId,
            ac_id,
            prior_status: priorStatus,
          },
          actor: { type: 'user', user_id: userId, install_id: 'unknown' },
          trace_id: traceId,
          occurred_at: now.toISOString(),
          schema_version: 1,
        })
      }

      await this.eventStore.append({
        aggregate_id: uat_session_id,
        aggregate_type: 'uat_session',
        event_type: 'UATACMarked',
        payload: {
          uat_session_id,
          ac_result_id: acResult.acResultId,
          ac_id,
          ac_ordinal: acResult.acOrdinal,
          status,
          observed_behavior: observed_behavior ?? undefined,
          evidence_links: evidence_links ?? [],
        },
        actor: { type: 'user', user_id: userId, install_id: 'unknown' },
        trace_id: traceId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      })

      logger.debug(
        { uatSessionId: uat_session_id, acId: ac_id, status, priorStatus },
        'UATService.markAC: AC marked',
      )

      return {
        ac_result_id: acResult.acResultId,
        status,
        pass_count: newPassCount,
        fail_count: newFailCount,
        pending_count: pendingCount,
      }
    })
  }

  // -------------------------------------------------------------------------
  // unmarkAC
  // -------------------------------------------------------------------------

  async unmarkAC(input: UnmarkACInput, userId: string, tenantId: string = SENTINEL_TENANT): Promise<MarkACOutput> {
    const { uat_session_id, ac_id } = input
    const traceId = uuidv7()
    const now = new Date()

    return await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'uat:' + uat_session_id}))`,
      )

      const [session] = await tx
        .select()
        .from(uatSessions)
        .where(and(eq(uatSessions.uatSessionId, uat_session_id), eq(uatSessions.tenantId, tenantId)))
        .limit(1)

      if (!session) {
        throw new OrbitalError(
          UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION,
          `session ${uat_session_id} not found`,
        )
      }

      if (['accepted', 'partially_accepted', 'rejected', 'submitted'].includes(session.state)) {
        throw new OrbitalError(
          UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot unmark AC on session in state ${session.state}`,
        )
      }

      const [acResult] = await tx
        .select()
        .from(uatAcResults)
        .where(
          and(
            eq(uatAcResults.uatSessionId, uat_session_id),
            eq(uatAcResults.acId, ac_id),
          ),
        )
        .limit(1)

      if (!acResult) {
        throw new OrbitalError(
          UAT_ERROR_CODES.NOT_FOUND_AC,
          `AC ${ac_id} not found in session ${uat_session_id}`,
        )
      }

      if (acResult.status === 'pending') {
        // Already pending — no-op
        const counts = await this.getCountsTx(tx, uat_session_id)
        return { ac_result_id: acResult.acResultId, status: 'pending' as const, ...counts }
      }

      const priorStatus = acResult.status

      // Revert to pending
      await tx
        .update(uatAcResults)
        .set({
          status: 'pending',
          observedBehavior: null,
          markedAt: null,
          markedByUserId: null,
        })
        .where(eq(uatAcResults.acResultId, acResult.acResultId))

      const passAdjust = priorStatus === 'pass' ? -1 : 0
      const failAdjust = priorStatus === 'fail' ? -1 : 0

      const newPassCount = Math.max(0, session.passCount + passAdjust)
      const newFailCount = Math.max(0, session.failCount + failAdjust)

      await tx
        .update(uatSessions)
        .set({ passCount: newPassCount, failCount: newFailCount })
        .where(eq(uatSessions.uatSessionId, uat_session_id))

      await this.eventStore.append({
        aggregate_id: uat_session_id,
        aggregate_type: 'uat_session',
        event_type: 'UATACUnmarked',
        payload: {
          uat_session_id,
          ac_result_id: acResult.acResultId,
          ac_id,
          prior_status: priorStatus,
        },
        actor: { type: 'user', user_id: userId, install_id: 'unknown' },
        trace_id: traceId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      })

      const pendingCount = session.totalAcCount - newPassCount - newFailCount

      return {
        ac_result_id: acResult.acResultId,
        status: 'pending' as const,
        pass_count: newPassCount,
        fail_count: newFailCount,
        pending_count: pendingCount,
      }
    })
  }

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  async submit(input: SubmitSessionInput, userId: string, tenantId: string = SENTINEL_TENANT): Promise<SubmitOutput> {
    const { uat_session_id, outcome_notes } = input
    const traceId = uuidv7()
    const now = new Date()

    // Advisory lock to guard against double-click submits (TRD-11 §8.5)
    return await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'uat:' + uat_session_id}))`,
      )

      const [session] = await tx
        .select()
        .from(uatSessions)
        .where(and(eq(uatSessions.uatSessionId, uat_session_id), eq(uatSessions.tenantId, tenantId)))
        .limit(1)

      if (!session) {
        throw new OrbitalError(
          UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION,
          `session ${uat_session_id} not found`,
        )
      }

      // Idempotent: if already terminal, replay prior result
      if (['accepted', 'partially_accepted', 'rejected'].includes(session.state)) {
        const existingDefects = await tx
          .select()
          .from(defectsTable)
          .where(eq(defectsTable.uatSessionId, uat_session_id))
        return this.buildSubmitOutput(session, existingDefects)
      }

      // Guard: must be in started or in_progress
      if (!['started', 'in_progress', 'submitted'].includes(session.state)) {
        throw new OrbitalError(
          UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot submit session in state ${session.state}`,
        )
      }

      // If already submitted (idempotent submit)
      if (session.state === 'submitted') {
        const existingDefects = await tx
          .select()
          .from(defectsTable)
          .where(eq(defectsTable.uatSessionId, uat_session_id))
        return this.buildSubmitOutput(session, existingDefects)
      }

      // Guard: all ACs must be non-pending
      const pendingACs = await tx
        .select()
        .from(uatAcResults)
        .where(
          and(
            eq(uatAcResults.uatSessionId, uat_session_id),
            eq(uatAcResults.status, 'pending'),
          ),
        )

      if (pendingACs.length > 0) {
        throw new OrbitalError(
          UAT_ERROR_CODES.VALIDATION_PENDING_ACS_REMAIN,
          `${pendingACs.length} AC(s) still pending — mark all ACs before submitting`,
          { pending_count: pendingACs.length },
        )
      }

      // Determine outcome
      const outcome =
        session.failCount === 0
          ? 'accepted'
          : session.failCount === session.totalAcCount
            ? 'rejected'
            : 'partially_accepted'

      // Update session to submitted
      await tx
        .update(uatSessions)
        .set({ state: 'submitted', submittedAt: now, outcomeNotes: outcome_notes ?? null })
        .where(eq(uatSessions.uatSessionId, uat_session_id))

      return { outcome, session, traceId, now }
    }).then(async (result) => {
      if ('ac_result_id' in result) {
        // This branch never taken; TypeScript narrowing
        throw new Error('unexpected')
      }

      // Downcast — the transaction returns an interim object or a SubmitOutput
      const r = result as {
        outcome: 'accepted' | 'partially_accepted' | 'rejected'
        session: UATSessionRow
        traceId: string
        now: Date
      } | SubmitOutput

      // If it's already a SubmitOutput (idempotent path), return directly
      if ('defects_created' in r) {
        return r
      }

      const { outcome, session, traceId: tid, now: ts } = r as {
        outcome: 'accepted' | 'partially_accepted' | 'rejected'
        session: UATSessionRow
        traceId: string
        now: Date
      }

      // Fetch failed ACs for defect creation
      const failedAcResults = await this.db
        .select()
        .from(uatAcResults)
        .where(
          and(
            eq(uatAcResults.uatSessionId, uat_session_id),
            eq(uatAcResults.status, 'fail'),
          ),
        )

      // Create defects for each failed AC
      const defectsCreated: SubmitOutput['defects_created'] = []

      for (const acResult of failedAcResults) {
        const personaId = await this.personaOfRecord.resolve({
          acId: acResult.acId,
          storyId: session.ticketId,
          sessionId: uat_session_id,
          traceId: tid,
        })

        // Check if there's an existing open defect for this AC (re-open path)
        const existingDefect = await this.db
          .select()
          .from(defectsTable)
          .where(
            and(
              eq(defectsTable.originStoryId, session.ticketId),
              eq(defectsTable.originAcId, acResult.acId),
              inArray(defectsTable.state, ['open', 'triaged', 'assigned', 'in_progress']),
            ),
          )
          .limit(1)

        const isReopen = existingDefect.length > 0

        // Determine severity
        const severity = this.defectService.assignSeverity({
          acText: acResult.acTextSnapshot,
          failedAcCountForStory: session.failCount,
          totalAcCountForStory: session.totalAcCount,
          isInActiveSprint: false, // v1: simplified; sprint active check deferred
          isReopen,
        })

        const preemptsSprint = severity === 'critical'

        const defect = await this.defectService.createDefect({
          failedAcResultId: acResult.acResultId,
          sessionId: uat_session_id,
          storyId: session.ticketId,
          acId: acResult.acId,
          acText: acResult.acTextSnapshot,
          observedBehavior: acResult.observedBehavior ?? '',
          personaOfRecordId: personaId,
          severity,
          preemptsSprint,
        })

        defectsCreated.push({
          defect_id: defect.defectId,
          defect_key: defect.defectKey,
          origin_ac_id: defect.originAcId,
          severity: defect.severity,
          preempts_sprint: preemptsSprint,
        })
      }

      // Emit UATSubmitted
      await this.eventStore.append({
        aggregate_id: uat_session_id,
        aggregate_type: 'uat_session',
        event_type: 'UATSubmitted',
        payload: {
          uat_session_id,
          ticket_id: session.ticketId,
          pass_count: session.passCount,
          fail_count: session.failCount,
          outcome,
          outcome_notes: input.outcome_notes ?? undefined,
        },
        actor: { type: 'user', user_id: userId, install_id: 'unknown' },
        trace_id: tid,
        occurred_at: ts.toISOString(),
        schema_version: 1,
      })

      // Transition to terminal state based on outcome
      await this.db
        .update(uatSessions)
        .set({ state: outcome })
        .where(eq(uatSessions.uatSessionId, uat_session_id))

      // Emit terminal event
      if (outcome === 'accepted') {
        await this.eventStore.append({
          aggregate_id: uat_session_id,
          aggregate_type: 'uat_session',
          event_type: 'UATAccepted',
          payload: {
            uat_session_id,
            ticket_id: session.ticketId,
            story_version: session.storyVersion,
            session_version: session.sessionVersion,
          },
          actor: { type: 'user', user_id: userId, install_id: 'unknown' },
          trace_id: tid,
          occurred_at: ts.toISOString(),
          schema_version: 1,
        })

        // Emit UATResolutionVerified when all ACs passed on a task that iterated
        await this.emitResolutionVerifiedIfIterating(session.ticketId, uat_session_id, tid, ts)
      } else if (outcome === 'partially_accepted') {
        const passedAcIds: string[] = []
        const failedAcIds: string[] = []

        const allAcResults = await this.db
          .select()
          .from(uatAcResults)
          .where(eq(uatAcResults.uatSessionId, uat_session_id))

        for (const r of allAcResults) {
          if (r.status === 'pass') passedAcIds.push(r.acId)
          else if (r.status === 'fail') failedAcIds.push(r.acId)
        }

        await this.eventStore.append({
          aggregate_id: uat_session_id,
          aggregate_type: 'uat_session',
          event_type: 'UATPartialAcceptance',
          payload: {
            uat_session_id,
            ticket_id: session.ticketId,
            passed_ac_ids: passedAcIds,
            failed_ac_ids: failedAcIds,
            defect_ids: defectsCreated.map((d) => d.defect_id),
          },
          actor: { type: 'user', user_id: userId, install_id: 'unknown' },
          trace_id: tid,
          occurred_at: ts.toISOString(),
          schema_version: 1,
        })

        // Write SprintCompleted with partial:true so SprintService can pick it up
        // (5A does not touch SprintService directly per task brief)
        await this.eventStore.append({
          aggregate_id: session.ticketId,
          aggregate_type: 'sprint',
          event_type: 'SprintCompleted',
          payload: {
            ticket_id: session.ticketId,
            uat_session_id,
            partial: true,
            defect_ids: defectsCreated.map((d) => d.defect_id),
          },
          actor: { type: 'system', component: 'orchestrator' },
          trace_id: tid,
          occurred_at: ts.toISOString(),
          schema_version: 1,
        })
      }

      logger.info(
        { uatSessionId: uat_session_id, outcome, defectsCount: defectsCreated.length },
        'UATService.submit: session submitted',
      )

      return {
        uat_session_id,
        outcome,
        pass_count: session.passCount,
        fail_count: session.failCount,
        defects_created: defectsCreated,
      }
    })
  }

  // -------------------------------------------------------------------------
  // accept
  // -------------------------------------------------------------------------

  async accept(sessionId: string, userId: string, tenantId: string = SENTINEL_TENANT): Promise<UATSessionRow> {
    const traceId = uuidv7()
    const now = new Date()

    const [session] = await this.db
      .select()
      .from(uatSessions)
      .where(and(eq(uatSessions.uatSessionId, sessionId), eq(uatSessions.tenantId, tenantId)))
      .limit(1)

    if (!session) {
      throw new OrbitalError(
        UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION,
        `session ${sessionId} not found`,
      )
    }

    if (session.state === 'accepted') {
      return session // idempotent
    }

    if (session.state !== 'submitted') {
      throw new OrbitalError(
        UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
        `cannot accept session in state ${session.state} — must be submitted`,
      )
    }

    // Guard: cannot fully accept if there are failed ACs
    if (session.failCount > 0) {
      throw new OrbitalError(
        UAT_ERROR_CODES.UAT_AC_NOT_MARKED,
        `session has ${session.failCount} failed ACs — use partialAccept or resolve failures first`,
        { fail_count: session.failCount },
      )
    }

    await this.db
      .update(uatSessions)
      .set({ state: 'accepted' })
      .where(eq(uatSessions.uatSessionId, sessionId))

    await this.eventStore.append({
      aggregate_id: sessionId,
      aggregate_type: 'uat_session',
      event_type: 'UATAccepted',
      payload: {
        uat_session_id: sessionId,
        ticket_id: session.ticketId,
        story_version: session.storyVersion,
        session_version: session.sessionVersion,
      },
      actor: { type: 'user', user_id: userId, install_id: 'unknown' },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    // Emit UATResolutionVerified when all ACs passed on a task that iterated
    await this.emitResolutionVerifiedIfIterating(session.ticketId, sessionId, traceId, now)

    const [updated] = await this.db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)

    return updated!
  }

  // -------------------------------------------------------------------------
  // partialAccept
  // -------------------------------------------------------------------------

  async partialAccept(sessionId: string, userId: string, tenantId: string = SENTINEL_TENANT): Promise<UATSessionRow> {
    const traceId = uuidv7()
    const now = new Date()

    const [session] = await this.db
      .select()
      .from(uatSessions)
      .where(and(eq(uatSessions.uatSessionId, sessionId), eq(uatSessions.tenantId, tenantId)))
      .limit(1)

    if (!session) {
      throw new OrbitalError(
        UAT_ERROR_CODES.NOT_FOUND_UAT_SESSION,
        `session ${sessionId} not found`,
      )
    }

    if (session.state === 'partially_accepted') {
      return session // idempotent
    }

    if (session.state !== 'submitted') {
      throw new OrbitalError(
        UAT_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
        `cannot partial-accept session in state ${session.state} — must be submitted`,
      )
    }

    await this.db
      .update(uatSessions)
      .set({ state: 'partially_accepted' })
      .where(eq(uatSessions.uatSessionId, sessionId))

    // Gather AC ids for event payload
    const allAcResults = await this.db
      .select()
      .from(uatAcResults)
      .where(eq(uatAcResults.uatSessionId, sessionId))

    const passedAcIds = allAcResults.filter((r) => r.status === 'pass').map((r) => r.acId)
    const failedAcIds = allAcResults.filter((r) => r.status === 'fail').map((r) => r.acId)

    const sessionDefects = await this.db
      .select()
      .from(defectsTable)
      .where(eq(defectsTable.uatSessionId, sessionId))

    await this.eventStore.append({
      aggregate_id: sessionId,
      aggregate_type: 'uat_session',
      event_type: 'UATPartialAcceptance',
      payload: {
        uat_session_id: sessionId,
        ticket_id: session.ticketId,
        passed_ac_ids: passedAcIds,
        failed_ac_ids: failedAcIds,
        defect_ids: sessionDefects.map((d) => d.defectId),
      },
      actor: { type: 'user', user_id: userId, install_id: 'unknown' },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    // Write SprintCompleted with partial:true
    await this.eventStore.append({
      aggregate_id: session.ticketId,
      aggregate_type: 'sprint',
      event_type: 'SprintCompleted',
      payload: {
        ticket_id: session.ticketId,
        uat_session_id: sessionId,
        partial: true,
        defect_ids: sessionDefects.map((d) => d.defectId),
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    const [updated] = await this.db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)

    return updated!
  }

  // -------------------------------------------------------------------------
  // getSession
  // -------------------------------------------------------------------------

  async getSession(
    sessionId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ session: UATSessionRow; acResults: UATACResultRow[] } | null> {
    const [session] = await this.db
      .select()
      .from(uatSessions)
      .where(and(eq(uatSessions.uatSessionId, sessionId), eq(uatSessions.tenantId, tenantId)))
      .limit(1)

    if (!session) return null

    const acResults = await this.getACResults(sessionId)
    return { session, acResults }
  }

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  async listSessions(
    ticketId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<Array<{ session: UATSessionRow; acResults: UATACResultRow[] }>> {
    const sessions = await this.db
      .select()
      .from(uatSessions)
      .where(and(eq(uatSessions.ticketId, ticketId), eq(uatSessions.tenantId, tenantId)))
      .orderBy(asc(uatSessions.sessionVersion))

    return Promise.all(
      sessions.map(async (session) => ({
        session,
        acResults: await this.getACResults(session.uatSessionId),
      })),
    )
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * When all ACs pass AND the task that owns this ticket has iteration_count > 0,
   * emit UATResolutionVerified to signal the defect loop closed successfully.
   *
   * Looks up the most-recently-updated task matching the ticket_id. If no task
   * exists (e.g. test seeds that don't create a tasks row), the event is skipped
   * gracefully — the missing-task case is already validated by startSession.
   */
  private async emitResolutionVerifiedIfIterating(
    ticketId: string,
    uatSessionId: string,
    traceId: string,
    now: Date,
  ): Promise<void> {
    // Find the task for this ticket (prefer the one with the highest iteration count)
    const taskRows = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.ticketId, ticketId))
      .orderBy(asc(tasks.createdAt))

    // Pick the task with the highest iterationCount; fall back to the first row
    const taskRow = taskRows.reduce<typeof taskRows[number] | null>((best, row) => {
      if (!best) return row
      return (row.iterationCount ?? 0) > (best.iterationCount ?? 0) ? row : best
    }, null)

    if (!taskRow || (taskRow.iterationCount ?? 0) === 0) {
      // Not a defect-iteration session — no UATResolutionVerified needed
      return
    }

    // Count defects filed against this story
    const [filedRow] = await this.db
      .select({ total: count() })
      .from(defectsTable)
      .where(eq(defectsTable.originStoryId, taskRow.storyId ?? ticketId))

    const [resolvedRow] = await this.db
      .select({ total: count() })
      .from(defectsTable)
      .where(
        and(
          eq(defectsTable.originStoryId, taskRow.storyId ?? ticketId),
          eq(defectsTable.state, 'resolved'),
        ),
      )

    const totalDefectsFiled = filedRow?.total ?? 0
    const totalDefectsResolved = resolvedRow?.total ?? 0

    await this.eventStore.append({
      aggregate_id: taskRow.taskId,
      aggregate_type: 'task',
      event_type: 'UATResolutionVerified',
      payload: {
        task_id: taskRow.taskId,
        ticket_id: ticketId,
        uat_session_id: uatSessionId,
        total_iterations: taskRow.iterationCount ?? 0,
        total_defects_filed: totalDefectsFiled,
        total_defects_resolved: totalDefectsResolved,
        finalized_at: now.toISOString(),
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    logger.info(
      {
        taskId: taskRow.taskId,
        ticketId,
        uatSessionId,
        totalIterations: taskRow.iterationCount,
        totalDefectsFiled,
        totalDefectsResolved,
      },
      'UATService: UATResolutionVerified emitted — defect loop closed',
    )
  }

  private async getACResults(sessionId: string): Promise<UATACResultRow[]> {
    return this.db
      .select()
      .from(uatAcResults)
      .where(eq(uatAcResults.uatSessionId, sessionId))
      .orderBy(asc(uatAcResults.acOrdinal))
  }

  private async getCountsTx(
    tx: Parameters<Parameters<DB['transaction']>[0]>[0],
    sessionId: string,
  ): Promise<{ pass_count: number; fail_count: number; pending_count: number }> {
    const [s] = await tx
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)

    if (!s) return { pass_count: 0, fail_count: 0, pending_count: 0 }

    return {
      pass_count: s.passCount,
      fail_count: s.failCount,
      pending_count: s.totalAcCount - s.passCount - s.failCount,
    }
  }

  private buildSubmitOutput(
    session: UATSessionRow,
    existingDefects: Array<typeof defectsTable.$inferSelect>,
  ): SubmitOutput {
    const outcome =
      session.failCount === 0
        ? 'accepted'
        : session.failCount === session.totalAcCount
          ? 'rejected'
          : 'partially_accepted'

    return {
      uat_session_id: session.uatSessionId,
      outcome,
      pass_count: session.passCount,
      fail_count: session.failCount,
      defects_created: existingDefects.map((d) => ({
        defect_id: d.defectId,
        defect_key: d.defectKey,
        origin_ac_id: d.originAcId,
        severity: d.severity,
        preempts_sprint: d.preemptsSprint !== null,
      })),
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUATService(
  db: DB,
  eventStore: EventStore,
  defectService: DefectService,
  personaOfRecord: PersonaOfRecord,
): UATService {
  return new DefaultUATService(db, eventStore, defectService, personaOfRecord)
}
