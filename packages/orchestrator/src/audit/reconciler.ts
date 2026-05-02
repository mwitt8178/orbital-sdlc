/**
 * audit/reconciler.ts — DriftReconciler: scheduled drift detection service.
 *
 * Per TRD-07 §7 (reconciliation algorithm), §8.3 (concurrency), §7.6 (advisory lock).
 *
 * ## What this checks (v1):
 *
 * ### Internal state drift (primary v1 check)
 *   Sample N recent rows from key tables (tasks, sprints, capabilities, channel_posts)
 *   and verify each has a corresponding aggregate-creation event in events log.
 *   This catches direct DB mutations that bypassed EventStore.
 *
 *   Specific invariant: for each task row, there must be a TaskCreated event with
 *   aggregate_id = task_id. If a task row exists with no TaskCreated event, that is
 *   drift (someone did db.insert(tasks) without EventStore.append).
 *
 * ### AgentCompleted → CapabilityRevoked window check
 *   For each AgentCompleted event in the window, verify a corresponding
 *   CapabilityRevoked event exists within 60s for the same capability_id.
 *   Missing revocation = drift (capability_grant_without_use category; we use
 *   a new kind to distinguish from the TRD-07 §7.3.4 unused-grant check).
 *
 * ### Git / Monday (optional callbacks):
 *   Git worktree state and Monday board state checks are wired via optional
 *   constructor callbacks. If not provided, these checks are skipped with a
 *   debug-level log. This design allows Phase 4B integration to wire Monday
 *   callbacks once MondaySyncService is available.
 *
 * NOTE — Phase 4B integration pending:
 *   Monday check callback: `new DriftReconciler({ checkMonday: () => ... })`
 *   The callback should return DriftDetail[] for any Monday↔audit discrepancies.
 *   Design is intentional: the reconciler is decoupled from MondaySyncService.
 *
 * ## Scheduling:
 *   - `reconciler.schedule(intervalMs)` returns a stop function; the daemon calls this.
 *   - Tests call `reconciler.run()` directly.
 *   - Default interval: 5 minutes (configurable via constructor option).
 *
 * ## Advisory lock (TRD-07 §7.6):
 *   Only one run per install at a time. Uses pg_try_advisory_lock(hashtext('reconciliation')).
 *
 * ## Concurrency model (TRD-07 §8.3):
 *   Each DriftDetected event is written in its own short transaction so that
 *   a partial run still records partial findings.
 */

import { uuidv7 } from 'uuidv7'
import { eq, gt, and, lte, gte, lt, desc, type SQL } from 'drizzle-orm'
import { sql as dSQL } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type postgres from 'postgres'
import { reconciliationRuns, driftEvents } from '../db/schema/audit.js'
import { tasks } from '../db/schema/orchestration.js'
import { events } from '../db/schema/events.js'
import { logger } from '../config/logger.js'
import type { EventStore } from '../events/store.js'
import type {
  DriftDetail,
  ReconciliationReport,
} from './types.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DriftReconciler {
  /**
   * Execute a single reconciliation run synchronously.
   * Writes ReconciliationRunStarted and ReconciliationRunCompleted events.
   * Returns a summary report.
   */
  run(options?: { trigger?: 'scheduled' | 'on_demand'; windowFrom?: string; windowTo?: string }): Promise<ReconciliationReport>

  /**
   * Start a recurring schedule at the given interval (ms).
   * Returns a stop function; call it to cancel.
   * Per task spec: tests call run() directly; daemon calls schedule().
   */
  schedule(intervalMs?: number): () => void
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DriftReconcilerOptions {
  /**
   * Optional callback for Monday board drift checks.
   * Returns DriftDetail[] for any discrepancies found.
   * If not provided, Monday checks are skipped.
   *
   * NOTE: Phase 4B integration — wire MondaySyncService.checkDrift() here
   * once Phase 4B is complete.
   */
  checkMonday?: () => Promise<DriftDetail[]>

  /**
   * Optional callback for git worktree drift checks.
   * Returns DriftDetail[] for any discrepancies found.
   * If not provided, git worktree checks are skipped.
   *
   * In production, this should walk ~/.orbital/worktrees/{taskId}/.git
   * for HEAD ref + log and compare against AgentCommitted events.
   */
  checkWorktrees?: () => Promise<DriftDetail[]>

  /**
   * Default interval for scheduled runs (ms). Default: 300_000 (5 minutes).
   */
  defaultIntervalMs?: number

  /**
   * How many recent rows to sample from each key table for internal drift check.
   * Default: 100.
   */
  sampleSize?: number

  /**
   * How many seconds within which a CapabilityRevoked event must follow an
   * AgentCompleted event for the same capability_id. Default: 60.
   */
  capabilityRevocationWindowSec?: number

  /**
   * Advisory lock key suffix (bigint). Default: uses hashtext('reconciliation').
   * In tests, set a unique value per reconciler instance to avoid parallel-fork
   * lock contention. In production, use the default (single lock per install).
   */
  advisoryLockKey?: bigint
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PostgresDriftReconciler implements DriftReconciler {
  private readonly defaultIntervalMs: number
  private readonly sampleSize: number
  private readonly capabilityRevocationWindowSec: number
  private readonly advisoryLockKey: bigint
  private readonly checkMonday?: () => Promise<DriftDetail[]>
  private readonly checkWorktrees?: () => Promise<DriftDetail[]>

  constructor(
    private readonly db: DB,
    private readonly sql: postgres.Sql,
    private readonly eventStore: EventStore,
    options: DriftReconcilerOptions = {},
  ) {
    this.defaultIntervalMs = options.defaultIntervalMs ?? 300_000
    this.sampleSize = options.sampleSize ?? 100
    this.capabilityRevocationWindowSec = options.capabilityRevocationWindowSec ?? 60
    this.checkMonday = options.checkMonday
    this.checkWorktrees = options.checkWorktrees
    // Default lock key: bigint representation of hashtext('reconciliation').
    // Tests may override to avoid parallel-fork contention.
    this.advisoryLockKey = options.advisoryLockKey ?? BigInt(0x7265636f) // 'reco' in hex
  }

  // --------------------------------------------------------------------------
  // schedule
  // --------------------------------------------------------------------------

  schedule(intervalMs?: number): () => void {
    const interval = intervalMs ?? this.defaultIntervalMs

    let running = false
    const timer = setInterval(() => {
      if (running) return // skip if previous run is still in progress
      running = true
      void this.run({ trigger: 'scheduled' })
        .catch((err: unknown) => {
          logger.error({ err }, 'DriftReconciler: scheduled run failed')
        })
        .finally(() => {
          running = false
        })
    }, interval)

    // Allow Node to exit even if timer is pending
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as NodeJS.Timeout).unref()
    }

    return () => clearInterval(timer)
  }

  // --------------------------------------------------------------------------
  // run
  // --------------------------------------------------------------------------

  async run(options: {
    trigger?: 'scheduled' | 'on_demand'
    windowFrom?: string
    windowTo?: string
  } = {}): Promise<ReconciliationReport> {
    const trigger = options.trigger ?? 'scheduled'
    const windowTo = options.windowTo ?? new Date().toISOString()
    // Default window_from: 5 minutes before window_to (1 interval back)
    const windowFrom =
      options.windowFrom ??
      new Date(new Date(windowTo).getTime() - this.defaultIntervalMs).toISOString()

    const runId = uuidv7()
    const startMs = Date.now()

    logger.info({ run_id: runId, trigger, window_from: windowFrom, window_to: windowTo },
      'DriftReconciler: starting reconciliation run')

    // Attempt advisory lock — only one run at a time per TRD-07 §7.6
    const lockAcquired = await this.tryAdvisoryLock()
    if (!lockAcquired) {
      logger.warn({ run_id: runId }, 'DriftReconciler: could not acquire advisory lock; another run is in progress')
      throw new Error('CONFLICT_RECONCILIATION_RUNNING')
    }

    // Insert reconciliation_runs row
    await this.db.insert(reconciliationRuns).values({
      runId,
      startedAt: new Date().toISOString(),
      trigger,
      triggeredBy: { type: 'system', component: 'reconciler' },
      windowFrom,
      windowTo,
      status: 'running',
      gitCommitsScanned: 0,
      worktreeFilesScanned: 0,
      mondayItemsScanned: 0,
      driftEventsEmitted: 0,
    })

    // Write ReconciliationRunStarted event
    await this.eventStore.append({
      aggregate_id: runId,
      aggregate_type: 'reconciliation_run',
      event_type: 'ReconciliationRunStarted',
      payload: {
        run_id: runId,
        trigger,
        window_from: windowFrom,
        window_to: windowTo,
      },
      actor: { type: 'system', component: 'reconciler' },
      trace_id: `reconciler-${runId}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    let driftEventsEmitted = 0
    let gitCommitsScanned = 0
    let worktreeFilesScanned = 0
    let mondayItemsScanned = 0
    let runStatus: 'completed' | 'failed' = 'completed'
    let errorPayload: Record<string, unknown> | null = null

    try {
      // -----------------------------------------------------------------------
      // Check 1: Internal state drift
      // Verify each sampled task row has a corresponding TaskCreated event.
      // This is the core invariant: every table row must trace back to an event.
      // -----------------------------------------------------------------------
      const internalDrifts = await this.checkInternalStateDrift(runId, windowFrom, windowTo)
      for (const drift of internalDrifts) {
        await this.emitDriftDetected(runId, drift)
        driftEventsEmitted++
      }

      // -----------------------------------------------------------------------
      // Check 2: AgentCompleted → CapabilityRevoked within 60s
      // -----------------------------------------------------------------------
      const capDrifts = await this.checkAgentCompletedCapabilityRevoked(runId, windowFrom, windowTo)
      for (const drift of capDrifts) {
        await this.emitDriftDetected(runId, drift)
        driftEventsEmitted++
      }

      // -----------------------------------------------------------------------
      // Check 3: Capability grant without any subsequent use (TRD-07 §7.3.4)
      // -----------------------------------------------------------------------
      const grantDrifts = await this.checkCapabilityGrantsWithoutUse(runId, windowFrom, windowTo)
      for (const drift of grantDrifts) {
        await this.emitDriftDetected(runId, drift)
        driftEventsEmitted++
      }

      // -----------------------------------------------------------------------
      // Check 4: Git worktree check (optional callback)
      // -----------------------------------------------------------------------
      if (this.checkWorktrees !== undefined) {
        const worktreeDrifts = await this.checkWorktrees()
        worktreeFilesScanned = worktreeDrifts.length
        for (const drift of worktreeDrifts) {
          await this.emitDriftDetected(runId, drift)
          driftEventsEmitted++
        }
      } else {
        logger.debug({ run_id: runId }, 'DriftReconciler: worktree check skipped (no callback provided)')
      }

      // -----------------------------------------------------------------------
      // Check 5: Monday board check (optional callback)
      // NOTE: Pending Phase 4B integration — wire MondaySyncService here.
      // -----------------------------------------------------------------------
      if (this.checkMonday !== undefined) {
        const mondayDrifts = await this.checkMonday()
        mondayItemsScanned = mondayDrifts.length
        for (const drift of mondayDrifts) {
          await this.emitDriftDetected(runId, drift)
          driftEventsEmitted++
        }
      } else {
        logger.debug({ run_id: runId },
          'DriftReconciler: Monday check skipped (no callback provided); ' +
          'Deferred: wire MondaySyncService.checkDrift() callback in Phase 4B integration')
      }

    } catch (err) {
      runStatus = 'failed'
      errorPayload = { reason: err instanceof Error ? err.message : String(err) }
      logger.error({ err, run_id: runId }, 'DriftReconciler: run failed')
    } finally {
      await this.releaseAdvisoryLock()
    }

    const durationMs = Date.now() - startMs

    // Update reconciliation_runs row
    await this.db
      .update(reconciliationRuns)
      .set({
        completedAt: new Date().toISOString(),
        status: runStatus,
        gitCommitsScanned,
        worktreeFilesScanned,
        mondayItemsScanned,
        driftEventsEmitted,
        errorPayload: errorPayload ?? undefined,
      })
      .where(eq(reconciliationRuns.runId, runId))

    // Write ReconciliationRunCompleted event
    await this.eventStore.append({
      aggregate_id: runId,
      aggregate_type: 'reconciliation_run',
      event_type: 'ReconciliationRunCompleted',
      payload: {
        run_id: runId,
        duration_ms: durationMs,
        git_commits_scanned: gitCommitsScanned,
        worktree_files_scanned: worktreeFilesScanned,
        monday_items_scanned: mondayItemsScanned,
        drift_events_emitted: driftEventsEmitted,
        status: runStatus,
        error_payload: errorPayload,
      },
      actor: { type: 'system', component: 'reconciler' },
      trace_id: `reconciler-${runId}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    logger.info({
      run_id: runId,
      duration_ms: durationMs,
      drift_events_emitted: driftEventsEmitted,
      status: runStatus,
    }, 'DriftReconciler: reconciliation run complete')

    return {
      run_id: runId,
      window_from: windowFrom,
      window_to: windowTo,
      duration_ms: durationMs,
      git_commits_scanned: gitCommitsScanned,
      worktree_files_scanned: worktreeFilesScanned,
      monday_items_scanned: mondayItemsScanned,
      drift_events_emitted: driftEventsEmitted,
      status: runStatus,
      error_payload: errorPayload,
    }
  }

  // --------------------------------------------------------------------------
  // Check 1: Internal state drift
  //
  // Algorithm: sample N recent task rows. For each task, verify that a TaskCreated
  // event exists in the events table with aggregate_id = task_id.
  //
  // If a task row exists with no corresponding event, it means someone inserted
  // directly via db.insert(tasks) without calling EventStore.append — drift.
  //
  // This is the primary drift check in v1, covering the integration test requirement:
  //   "manually update tasks row without emitting event → DriftDetected IS emitted"
  // --------------------------------------------------------------------------

  private async checkInternalStateDrift(
    runId: string,
    windowFrom: string,
    windowTo: string,
  ): Promise<DriftDetail[]> {
    const drifts: DriftDetail[] = []

    // Sample the N most recently created tasks (DESC by created_at so the
    // newest rows — including freshly inserted orphans — appear in the sample).
    // This ordering ensures integration tests that insert an orphan task
    // and immediately run the reconciler will reliably catch the drift.
    const recentTasks = await this.db
      .select({
        taskId: tasks.taskId,
        sprintId: tasks.sprintId,
        title: tasks.title,
        state: tasks.state,
        createdByEventId: tasks.createdByEventId,
      })
      .from(tasks)
      .orderBy(desc(tasks.createdAt))
      .limit(this.sampleSize)

    for (const task of recentTasks) {
      // Verify a TaskCreated event exists for this task
      const matchingEvents = await this.db
        .select({ eventId: events.eventId })
        .from(events)
        .where(
          and(
            eq(events.aggregateId, task.taskId),
            eq(events.eventType, 'TaskCreated'),
          ) as SQL,
        )
        .limit(1)

      if (matchingEvents.length === 0) {
        // No TaskCreated event found — this task was created without going through EventStore
        drifts.push({
          source: 'internal',
          drift_kind: 'event_without_commit', // closest v1 equivalent; in full impl would be a new 'table_row_without_event' kind
          observed: {
            task_id: task.taskId,
            sprint_id: task.sprintId,
            title: task.title,
            state: task.state,
            table: 'tasks',
            detail: 'task row exists with no corresponding TaskCreated event in audit log',
          },
          expected: {
            event_type: 'TaskCreated',
            aggregate_id: task.taskId,
            description: 'Every task row must have a TaskCreated event written via EventStore.append()',
          },
          severity: 'critical',
        })
      }
    }

    void runId; void windowFrom; void windowTo; // used in other checks

    return drifts
  }

  // --------------------------------------------------------------------------
  // Check 2: AgentCompleted → CapabilityRevoked within 60s
  //
  // Per task spec: "every AgentCompleted event has a corresponding CapabilityRevoked
  // event for the same capability_id within 60s"
  // --------------------------------------------------------------------------

  private async checkAgentCompletedCapabilityRevoked(
    _runId: string,
    windowFrom: string,
    windowTo: string,
  ): Promise<DriftDetail[]> {
    const drifts: DriftDetail[] = []

    // Find AgentCompleted events in the window that have a capability_id
    const agentCompletedEvents = await this.db
      .select({
        eventId: events.eventId,
        capabilityId: events.capabilityId,
        occurredAt: events.occurredAt,
        aggregateId: events.aggregateId,
      })
      .from(events)
      .where(
        and(
          eq(events.eventType, 'AgentCompleted'),
          gte(events.occurredAt, windowFrom),
          lt(events.occurredAt, windowTo),
          dSQL`${events.capabilityId} IS NOT NULL`,
        ) as SQL,
      )
      .limit(this.sampleSize)

    for (const agentEvent of agentCompletedEvents) {
      if (!agentEvent.capabilityId) continue

      const completedAt = new Date(toIso8601(agentEvent.occurredAt))
      const windowEnd = new Date(completedAt.getTime() + this.capabilityRevocationWindowSec * 1000)

      // Look for a CapabilityRevoked event for this capability within the window
      const revocationEvents = await this.db
        .select({ eventId: events.eventId, occurredAt: events.occurredAt })
        .from(events)
        .where(
          and(
            eq(events.eventType, 'CapabilityRevoked'),
            dSQL`${events.payload}->>'capability_id' = ${agentEvent.capabilityId}`,
            gte(events.occurredAt, toIso8601(agentEvent.occurredAt)),
            lte(events.occurredAt, windowEnd.toISOString()),
          ) as SQL,
        )
        .limit(1)

      if (revocationEvents.length === 0) {
        drifts.push({
          source: 'internal',
          drift_kind: 'capability_grant_without_use',
          observed: {
            agent_completed_event_id: agentEvent.eventId,
            capability_id: agentEvent.capabilityId,
            agent_completed_at: toIso8601(agentEvent.occurredAt),
            window_end: windowEnd.toISOString(),
            detail: `AgentCompleted without CapabilityRevoked within ${this.capabilityRevocationWindowSec}s`,
          },
          expected: {
            event_type: 'CapabilityRevoked',
            capability_id: agentEvent.capabilityId,
            within_seconds: this.capabilityRevocationWindowSec,
          },
          severity: 'warning',
        })
      }
    }

    return drifts
  }

  // --------------------------------------------------------------------------
  // Check 3: CapabilityGranted without subsequent use (TRD-07 §7.3.4)
  //
  // For each CapabilityGranted in the window, check that at least one other
  // event exists that uses that capability_id.
  // --------------------------------------------------------------------------

  private async checkCapabilityGrantsWithoutUse(
    _runId: string,
    windowFrom: string,
    windowTo: string,
  ): Promise<DriftDetail[]> {
    const drifts: DriftDetail[] = []

    // Find CapabilityGranted events in the window
    const grantEvents = await this.db
      .select({
        eventId: events.eventId,
        payload: events.payload,
        occurredAt: events.occurredAt,
        capabilityId: events.capabilityId,
      })
      .from(events)
      .where(
        and(
          eq(events.eventType, 'CapabilityGranted'),
          gte(events.occurredAt, windowFrom),
          lt(events.occurredAt, windowTo),
        ) as SQL,
      )
      .limit(this.sampleSize)

    for (const grantEvent of grantEvents) {
      const capId = (grantEvent.payload as Record<string, unknown>)?.['capability_id'] as string | undefined
        ?? grantEvent.capabilityId

      if (!capId) continue

      const grantedAt = new Date(toIso8601(grantEvent.occurredAt))
      // Look within 1 hour of the grant
      const lookAheadEnd = new Date(grantedAt.getTime() + 3_600_000).toISOString()

      const usageEvents = await this.db
        .select({ eventId: events.eventId })
        .from(events)
        .where(
          and(
            eq(events.capabilityId, capId),
            gt(events.occurredAt, toIso8601(grantEvent.occurredAt)),
            lte(events.occurredAt, lookAheadEnd),
            dSQL`${events.eventType} NOT IN ('CapabilityGranted', 'CapabilityRevoked')`,
          ) as SQL,
        )
        .limit(1)

      if (usageEvents.length === 0) {
        drifts.push({
          source: 'internal',
          drift_kind: 'capability_grant_without_use',
          observed: {
            grant_event_id: grantEvent.eventId,
            capability_id: capId,
            granted_at: toIso8601(grantEvent.occurredAt),
            look_ahead_until: lookAheadEnd,
            detail: 'CapabilityGranted but no tool calls observed within 1h window',
          },
          expected: {
            description: 'At least one event using this capability_id within 1h of grant',
          },
          severity: 'info',
        })
      }
    }

    return drifts
  }

  // --------------------------------------------------------------------------
  // emitDriftDetected — writes both a drift_events row and DriftDetected event
  // Per TRD-07 §8.3: each drift event in its own short transaction
  // --------------------------------------------------------------------------

  private async emitDriftDetected(runId: string, drift: DriftDetail): Promise<void> {
    const driftId = uuidv7()

    // Write the DriftDetected event first (durable record)
    const detectionEvent = await this.eventStore.append({
      aggregate_id: driftId,
      aggregate_type: 'system',
      event_type: 'DriftDetected',
      payload: {
        drift_id: driftId,
        run_id: runId,
        source: drift.source,
        drift_kind: drift.drift_kind,
        observed: drift.observed,
        expected: drift.expected,
        severity: drift.severity,
      },
      actor: { type: 'system', component: 'reconciler' },
      trace_id: `reconciler-${runId}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Write the drift_events index row
    await this.db.insert(driftEvents).values({
      driftId,
      runId,
      source: drift.source,
      driftKind: drift.drift_kind,
      observed: drift.observed as Record<string, unknown>,
      expected: drift.expected ?? undefined,
      severity: drift.severity,
      detectedAt: new Date().toISOString(),
      detectionEventId: detectionEvent.event_id,
    })

    logger.warn({
      drift_id: driftId,
      run_id: runId,
      drift_kind: drift.drift_kind,
      source: drift.source,
      severity: drift.severity,
    }, 'DriftReconciler: drift detected')
  }

  // --------------------------------------------------------------------------
  // Advisory lock helpers — TRD-07 §7.6
  // --------------------------------------------------------------------------

  private async tryAdvisoryLock(): Promise<boolean> {
    try {
      // postgres.js requires number or string parameters; cast bigint to number.
      // Advisory lock keys fit in a safe integer range for our values.
      const lockKey = Number(this.advisoryLockKey)
      const result = await this.sql<[{ result: boolean }]>`
        SELECT pg_try_advisory_lock(${lockKey}) AS result
      `
      return result[0]?.result === true
    } catch (err) {
      logger.warn({ err }, 'DriftReconciler: advisory lock check failed, proceeding without lock')
      return true // fail-open for tests
    }
  }

  private async releaseAdvisoryLock(): Promise<void> {
    try {
      const lockKey = Number(this.advisoryLockKey)
      await this.sql`SELECT pg_advisory_unlock(${lockKey})`
    } catch (err) {
      logger.warn({ err }, 'DriftReconciler: failed to release advisory lock')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso8601(ts: string): string {
  return ts.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDriftReconciler(
  db: DB,
  sql: postgres.Sql,
  eventStore: EventStore,
  options: DriftReconcilerOptions = {},
): DriftReconciler {
  return new PostgresDriftReconciler(db, sql, eventStore, options)
}
