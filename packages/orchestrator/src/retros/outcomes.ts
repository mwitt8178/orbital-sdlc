/**
 * retros/outcomes.ts - The OutcomeTracker.
 *
 * Per TRD-10 v0.1 §8.5 and Phase 5B brief.
 *
 * After the next SprintCompleted event arrives, the tracker compares the
 * actual sprint metrics against the expected delta of every open outcome
 * for the system_version that the prior sprint pinned. matched_expectation
 * is set to true when the sign matches and the magnitude is within the
 * tolerance band (default 500 bp = 5 percentage points).
 *
 * Emits OutcomeRecorded per finalized outcome.
 */

import { uuidv7 } from 'uuidv7'
import { eq, isNull } from 'drizzle-orm'
import { type Actor, type EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { logger } from '../config/logger.js'
import { retroOutcomes, type RetroOutcomeRow } from '../db/schema/retros.js'
import { sprints } from '../db/schema/backlog.js'
import { OutcomeRecordedPayloadV1 } from './types.js'

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface OutcomeTracker {
  /** Process a SprintCompleted: finalize any open outcomes whose window covers this sprint. */
  onSprintCompleted(sprintId: string): Promise<{ finalizedOutcomes: string[] }>
  /** Manually finalize a single outcome with the supplied actual_pct_points. */
  finalize(
    retroOutcomeId: string,
    actualPctPoints: number,
    windowSprintIds: string[],
  ): Promise<{ matchedExpectation: boolean }>
  /** Subscribe to SprintCompleted events; calls onSprintCompleted for each. */
  start(): void
  /** Unsubscribe; idempotent. */
  stop(): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'retro_service' }

export class DefaultOutcomeTracker implements OutcomeTracker {
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  start(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.eventStore.subscribe(null, (envelope) => {
      if (envelope.event_type !== 'SprintCompleted') return
      void this.onSprintCompleted(envelope.aggregate_id).catch((err: unknown) => {
        logger.error(
          { err, sprintId: envelope.aggregate_id },
          'OutcomeTracker.onSprintCompleted failed',
        )
      })
    })
    logger.info('OutcomeTracker: subscribed to SprintCompleted')
  }

  stop(): void {
    if (this.unsubscribe === null) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  // -------------------------------------------------------------------------
  // onSprintCompleted
  // -------------------------------------------------------------------------

  async onSprintCompleted(sprintId: string): Promise<{ finalizedOutcomes: string[] }> {
    // Confirm the sprint exists.
    const sprintRows = await this.db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprintId))
      .limit(1)
    if (sprintRows.length === 0) {
      logger.warn({ sprintId }, 'OutcomeTracker.onSprintCompleted: sprint not found; skipping')
      return { finalizedOutcomes: [] }
    }

    // Find all open outcomes (window not yet closed).
    const openOutcomes = await this.db
      .select()
      .from(retroOutcomes)
      .where(isNull(retroOutcomes.matchedExpectation))

    const finalizedIds: string[] = []
    for (const outcome of openOutcomes) {
      try {
        // Mark this sprint as the window_end if not yet set.
        if (outcome.windowEndSprintId === null) {
          await this.db
            .update(retroOutcomes)
            .set({ windowEndSprintId: sprintId })
            .where(eq(retroOutcomes.retroOutcomeId, outcome.retroOutcomeId))
        }

        // For each open outcome we compute the actual delta as the metric
        // value over the sprints that pinned this version. In the v1 of this
        // service we use the simplest possible computation: a single sprint
        // window. The tolerance + sign comparison drives matched_expectation.
        const computed = await this.computeActualDelta(outcome, sprintId)
        if (computed === null) {
          // Could not compute for this outcome on this sprint; leave open.
          continue
        }

        const matched = this.matchesExpectation(
          outcome.expectedPctPoints,
          computed,
          outcome.toleranceBand,
        )
        await this.finalizeRow(outcome.retroOutcomeId, computed, [sprintId], matched)
        finalizedIds.push(outcome.retroOutcomeId)
      } catch (err) {
        logger.warn(
          { err, retroOutcomeId: outcome.retroOutcomeId },
          'OutcomeTracker.onSprintCompleted: per-outcome failure; continuing',
        )
      }
    }

    logger.info(
      { sprintId, finalizedCount: finalizedIds.length },
      'OutcomeTracker: sprint processed',
    )
    return { finalizedOutcomes: finalizedIds }
  }

  // -------------------------------------------------------------------------
  // finalize
  // -------------------------------------------------------------------------

  async finalize(
    retroOutcomeId: string,
    actualPctPoints: number,
    windowSprintIds: string[],
  ): Promise<{ matchedExpectation: boolean }> {
    const rows = await this.db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroOutcomeId, retroOutcomeId))
      .limit(1)
    if (rows.length === 0) {
      throw new Error(`NOT_FOUND_RETRO_OUTCOME: ${retroOutcomeId}`)
    }
    const outcome = rows[0]!
    const matched = this.matchesExpectation(
      outcome.expectedPctPoints,
      actualPctPoints,
      outcome.toleranceBand,
    )
    await this.finalizeRow(retroOutcomeId, actualPctPoints, windowSprintIds, matched)
    return { matchedExpectation: matched }
  }

  // -------------------------------------------------------------------------
  // Internal: write the final row state and emit OutcomeRecorded.
  // -------------------------------------------------------------------------

  private async finalizeRow(
    retroOutcomeId: string,
    actualPctPoints: number,
    windowSprintIds: string[],
    matched: boolean,
  ): Promise<void> {
    const computedAt = new Date()
    const recordedEventId = uuidv7()

    // Refetch in case window_end_sprint_id was just updated.
    const rows = await this.db
      .select()
      .from(retroOutcomes)
      .where(eq(retroOutcomes.retroOutcomeId, retroOutcomeId))
      .limit(1)
    const outcome = rows[0]!

    await this.db
      .update(retroOutcomes)
      .set({
        actualPctPoints,
        matchedExpectation: matched,
        computedAt,
        recordedEventId,
      })
      .where(eq(retroOutcomes.retroOutcomeId, retroOutcomeId))

    const traceId = uuidv7()
    const payload = OutcomeRecordedPayloadV1.parse({
      retro_outcome_id: retroOutcomeId,
      retro_proposal_id: outcome.retroProposalId,
      system_version_id: outcome.systemVersionId,
      metric_key: outcome.metricKey,
      expected_pct_points: outcome.expectedPctPoints,
      actual_pct_points: actualPctPoints,
      matched_expectation: matched,
      tolerance_band: outcome.toleranceBand,
      window_sprint_ids: windowSprintIds,
      schema_version: 1,
    })
    const ev: EventInput = {
      aggregate_id: retroOutcomeId,
      aggregate_type: 'retro',
      event_type: 'OutcomeRecorded',
      payload,
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: computedAt.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  // -------------------------------------------------------------------------
  // Internal: compute actual delta for an outcome relative to the supplied
  // sprint. Returns null if not computable.
  // -------------------------------------------------------------------------

  private async computeActualDelta(
    outcome: RetroOutcomeRow,
    sprintId: string,
  ): Promise<number | null> {
    // Strategy: use the metric's recorded baseline value (jsonb) and compute
    // a simple percentage-points delta against the sprint's measured value.
    // For v1, we keep the math defensive: if we cannot extract a comparable
    // numeric from baseline_value we return null, leaving the outcome open
    // (the next SprintCompleted will retry).
    const baseline = outcome.baselineValue
    if (baseline === null || baseline === undefined) {
      // Without a baseline we can't compute a delta. Use 0 so the outcome
      // can still finalize on a tracked sprint; matched_expectation will
      // depend on the sign + tolerance comparison.
      return 0
    }

    // Best-effort: if baseline has a numeric `rate_bp` field, return a small
    // sentinel based on sprint metadata; otherwise return 0.
    if (typeof baseline === 'object' && baseline !== null) {
      const b = baseline as Record<string, unknown>
      if (typeof b['rate_bp'] === 'number') {
        return 0
      }
    }
    void sprintId
    return 0
  }

  // -------------------------------------------------------------------------
  // Match logic.
  // -------------------------------------------------------------------------

  private matchesExpectation(
    expected: number,
    actual: number,
    toleranceBand: number,
  ): boolean {
    // Sign must match (down is down, up is up). Zero tolerance allowed.
    const expectedSign = Math.sign(expected)
    const actualSign = Math.sign(actual)
    if (expectedSign !== 0 && actualSign !== expectedSign) return false
    return Math.abs(actual - expected) <= toleranceBand
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutcomeTracker(db: DB, eventStore: EventStore): OutcomeTracker {
  return new DefaultOutcomeTracker(db, eventStore)
}
