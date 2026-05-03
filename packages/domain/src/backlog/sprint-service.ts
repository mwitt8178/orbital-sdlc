/**
 * backlog/sprint-service.ts — SprintService.
 *
 * Per TRD-02 v0.2 §6.1, §7.2 (sprint state machine), §10 (multi-sprint).
 *
 * Responsibilities:
 *   - create(params)               → inserts a sprint in 'planning'
 *   - createCommitment(params)     → writes the sprint_commitments row, transitions sprint to 'ready'
 *   - start(sprintId)              → transitions ready → active, builds DAG from
 *                                    sprint_commitments + tasks + task_dependencies,
 *                                    calls Scheduler.addSprint, emits SprintStarted
 *   - pause(sprintId)              → delegates to PauseController.pause; transitions active → paused
 *   - resume(sprintId)             → delegates to PauseController.resume; transitions paused → active
 *   - complete(sprintId)           → transitions active|completing → completed; calls Scheduler.removeSprint
 *
 * The BlockerService-onRoute callback is rebound at start() and unbound at
 * complete()/pause()-handle-resume cycle. Resolver tasks created via the
 * callback insert real `tasks` rows so the existing Scheduler.tick() loop
 * picks them up.
 */

import { uuidv7 } from 'uuidv7'
import { eq, and, inArray, sql as dSQL } from 'drizzle-orm'

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import type { Scheduler } from '../../../orchestrator/src/orchestration/scheduler.js'
import type { PauseController } from '../../../orchestrator/src/orchestration/pause.js'
import type { BlockerService } from '../comms/blockers.js'
import {
  sprints,
  sprintCommitments,
  type SprintRow,
  type SprintStatus,
  type SprintPriorityClass,
} from '@orbital/db'
import { tasks, taskDependencies } from '@orbital/db'
import {
  DEFAULT_RETRY_BUDGET,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_WALL_CLOCK_TIMEOUT_MS,
} from '../../../orchestrator/src/orchestration/types.js'
import { assertAcyclic, type DagNode, type DagEdge } from '../../../orchestrator/src/orchestration/dag.js'
import { logger } from '../logger.js'
import {
  CreateSprintInputSchema,
  SprintCommitmentInputSchema,
  isValidSprintTransition,
  BACKLOG_ERROR_CODES,
  type CreateSprintInput,
  type SprintCommitmentInput,
} from './types.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface SprintService {
  create(params: CreateSprintInput, actor?: Actor, tenantId?: string): Promise<SprintRow>
  createCommitment(input: SprintCommitmentInput, actor?: Actor, tenantId?: string): Promise<void>
  start(sprintId: string, actor?: Actor, tenantId?: string): Promise<{ sprintId: string; startedAt: Date }>
  pause(sprintId: string, reason: string, actor?: Actor, tenantId?: string): Promise<{ pausedAt: Date }>
  resume(sprintId: string, actor?: Actor, tenantId?: string): Promise<{ resumedAt: Date }>
  complete(sprintId: string, actor?: Actor, tenantId?: string): Promise<{ completedAt: Date }>

  list(filter?: { status?: SprintStatus }, tenantId?: string): Promise<SprintRow[]>
  get(sprintId: string, tenantId?: string): Promise<SprintRow | null>
}

export interface SprintServiceOptions {
  /** Default install ceiling on max simultaneously active+paused sprints. */
  maxActiveSprints?: number
  /** Optional BlockerService to wire Scheduler-aware resolver task creation. */
  blockerService?: BlockerService
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultSprintService implements SprintService {
  private readonly maxActiveSprints: number
  private readonly blockerService?: BlockerService
  private routeCallbackInstalled = false

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly scheduler: Scheduler,
    private readonly pauseController: PauseController,
    options: SprintServiceOptions = {},
  ) {
    this.maxActiveSprints = options.maxActiveSprints ?? 3
    if (options.blockerService) this.blockerService = options.blockerService
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(params: CreateSprintInput, actor: Actor = SYSTEM_ACTOR, tenantId: string = SENTINEL_TENANT): Promise<SprintRow> {
    const parsed = CreateSprintInputSchema.parse(params)

    const traceId = uuidv7()
    const now = new Date()
    const sprintId = uuidv7()

    // Multi-sprint ceiling check (TRD-02 §10.1). Lock the worker_pool_state
    // row to serialize concurrent creates.
    const sprint = await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT id FROM worker_pool_state WHERE id = 1 FOR UPDATE`,
      )

      const activeRows = await tx
        .select()
        .from(sprints)
        .where(and(inArray(sprints.status, ['active', 'paused']), eq(sprints.tenantId, tenantId)))
      if (activeRows.length >= this.maxActiveSprints) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_SPRINT_CEILING_EXCEEDED,
          `cannot create sprint: ceiling ${this.maxActiveSprints} reached`,
          { active_count: activeRows.length, ceiling: this.maxActiveSprints },
        )
      }

      // Determine sequence: next monotonic value
      const seqRows = await tx
        .select({ sequence: sprints.sequence })
        .from(sprints)
        .orderBy(dSQL`sequence DESC`)
        .limit(1)
      const nextSequence = (seqRows[0]?.sequence ?? 0) + 1

      const [row] = await tx
        .insert(sprints)
        .values({
          sprintId,
          tenantId,
          name: parsed.name,
          sequence: nextSequence,
          status: 'planning',
          storyPointCapacity: parsed.story_point_capacity,
          wallClockTargetMs: parsed.wall_clock_target_ms ?? null,
          budgetUsdCents: parsed.budget_usd_cents,
          concurrencyShare: parsed.concurrency_share ?? 100,
          priorityClass: (parsed.priority_class ?? 'standard') as SprintPriorityClass,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        })
        .returning()

      if (!row) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.INTERNAL_DB_ERROR,
          'INSERT sprint returned no rows',
        )
      }
      return row
    })

    const ev: EventInput = {
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCreated',
      payload: {
        sprint_id: sprintId,
        name: parsed.name,
        sequence: sprint.sequence,
        story_point_capacity: parsed.story_point_capacity,
        budget_usd_cents: parsed.budget_usd_cents,
        concurrency_share: parsed.concurrency_share ?? 100,
        priority_class: parsed.priority_class ?? 'standard',
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return sprint
  }

  // -------------------------------------------------------------------------
  // createCommitment — writes a commitment row + transitions planning → ready
  // -------------------------------------------------------------------------

  async createCommitment(
    input: SprintCommitmentInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<void> {
    const parsed = SprintCommitmentInputSchema.parse(input)

    const traceId = uuidv7()
    const now = new Date()
    const commitmentId = uuidv7()

    await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'sprint:' + parsed.sprint_id}))`,
      )

      const rows = await tx
        .select()
        .from(sprints)
        .where(and(eq(sprints.sprintId, parsed.sprint_id), eq(sprints.tenantId, tenantId)))
        .limit(1)
      const sprint = rows[0]
      if (!sprint) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.NOT_FOUND_SPRINT,
          `sprint ${parsed.sprint_id} not found`,
        )
      }
      if (!isValidSprintTransition(sprint.status, 'ready')) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot commit: sprint status ${sprint.status} cannot transition to ready`,
          { from: sprint.status, to: 'ready' },
        )
      }

      await tx.insert(sprintCommitments).values({
        commitmentId,
        sprintId: parsed.sprint_id,
        ceremonyId: parsed.ceremony_id ?? null,
        selectedStoryIds: parsed.selected_story_ids,
        capacityUsedPoints: parsed.capacity_used_points,
        identifiedRisks: (parsed.identified_risks ?? []) as Array<{
          risk: string
          severity: 'low' | 'medium' | 'high'
          mitigation: string | null
        }>,
        raisedConcerns: (parsed.raised_concerns ?? []) as Array<{
          raisedBy: string
          concern: string
          disposition: 'accepted' | 'deferred' | 'rejected'
          rationale: string
        }>,
        isPartial: parsed.is_partial ?? false,
        createdAt: now,
        schemaVersion: 1,
      })

      await tx
        .update(sprints)
        .set({ status: 'ready', updatedAt: now })
        .where(eq(sprints.sprintId, parsed.sprint_id))
    })

    logger.debug({ sprintId: parsed.sprint_id, commitmentId }, 'SprintService.createCommitment')

    // No dedicated CommitmentWritten event in TRD-02 (the ceremony substrate
    // emits CeremonyOutputWritten elsewhere). We append a synthetic record
    // for traceability.
    const ev: EventInput = {
      aggregate_id: parsed.sprint_id,
      aggregate_type: 'sprint',
      event_type: 'SprintCommitmentWritten',
      payload: {
        sprint_id: parsed.sprint_id,
        commitment_id: commitmentId,
        selected_story_ids: parsed.selected_story_ids,
        capacity_used_points: parsed.capacity_used_points,
        is_partial: parsed.is_partial ?? false,
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  // -------------------------------------------------------------------------
  // start — builds DAG, calls Scheduler.addSprint, emits SprintStarted
  // -------------------------------------------------------------------------

  async start(
    sprintId: string,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ sprintId: string; startedAt: Date }> {
    const traceId = uuidv7()
    const now = new Date()

    // Inside the lock: validate state + load commitment.
    const { commitmentId, selectedStoryIds, sprint } = await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'sprint:' + sprintId}))`,
      )

      const sRows = await tx.select().from(sprints).where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId))).limit(1)
      const sprint = sRows[0]
      if (!sprint) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.NOT_FOUND_SPRINT,
          `sprint ${sprintId} not found`,
        )
      }
      if (!isValidSprintTransition(sprint.status, 'active')) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot start: sprint status ${sprint.status} cannot transition to active`,
          { from: sprint.status, to: 'active' },
        )
      }

      const cRows = await tx
        .select()
        .from(sprintCommitments)
        .where(eq(sprintCommitments.sprintId, sprintId))
        .limit(1)
      const commitment = cRows[0]
      if (!commitment) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_NO_COMMITMENT,
          `sprint ${sprintId} has no commitment`,
        )
      }

      await tx
        .update(sprints)
        .set({ status: 'active', startedAt: now, updatedAt: now })
        .where(eq(sprints.sprintId, sprintId))

      return {
        commitmentId: commitment.commitmentId,
        selectedStoryIds: commitment.selectedStoryIds,
        sprint,
      }
    })

    // Load tasks (real DAG nodes) for the committed stories, validate acyclicity.
    let storyTasks: Array<{ taskId: string; state: string }> = []
    let edges: DagEdge[] = []
    if (selectedStoryIds.length > 0) {
      const taskRows = await this.db
        .select({ taskId: tasks.taskId, state: tasks.state, storyId: tasks.storyId })
        .from(tasks)
        .where(inArray(tasks.storyId, selectedStoryIds))
      storyTasks = taskRows.map((r) => ({ taskId: r.taskId, state: r.state }))

      if (storyTasks.length > 0) {
        const taskIds = storyTasks.map((t) => t.taskId)
        const depRows = await this.db
          .select()
          .from(taskDependencies)
          .where(
            and(
              inArray(taskDependencies.predecessorTaskId, taskIds),
              inArray(taskDependencies.successorTaskId, taskIds),
            ),
          )
        edges = depRows.map((d) => ({
          predecessorTaskId: d.predecessorTaskId,
          successorTaskId: d.successorTaskId,
          blocking: d.blocking,
        }))

        const nodes: DagNode[] = storyTasks.map((t) => ({ taskId: t.taskId, state: t.state }))
        // Throws INTERNAL_DAG_CYCLE if a cycle exists
        assertAcyclic(nodes, edges)
      }
    }

    // Build scheduler sprint descriptor.
    const schedulerSprint = {
      sprintId,
      priority: priorityClassToWeight(sprint.priorityClass),
    } as const

    // Atomicity: scheduler.addSprint + SprintStarted event must be committed
    // together. scheduler.addSprint is in-memory and synchronous; if it throws,
    // we must not emit the SprintStarted event.
    //
    // Strategy: call scheduler.addSprint first (throws on error with no DB
    // side-effect), then emit the event. If event append fails, we remove the
    // sprint from the scheduler to restore consistency.
    try {
      // Real handoff to scheduler. Existing Scheduler.addSprint signature is
      // (SchedulerSprint, TaskRow[]) → void — we pass an empty TaskRow[] because
      // tasks are read from DB on every tick().
      this.scheduler.addSprint(schedulerSprint, [])
    } catch (err) {
      // Scheduler rejected the sprint (e.g. at capacity). Reverse the DB status
      // update by marking the sprint back to 'ready' so it can be retried.
      await this.db
        .update(sprints)
        .set({ status: 'ready', startedAt: null, updatedAt: new Date() })
        .where(eq(sprints.sprintId, sprintId))

      throw new OrbitalError(
        BACKLOG_ERROR_CODES.CONFLICT_SPRINT_CEILING_EXCEEDED,
        `scheduler.addSprint rejected sprint ${sprintId}: ${(err as Error).message}`,
        { sprintId },
      )
    }

    // Wire the BlockerService.onRoute callback so blocker resolutions create
    // real task rows that the scheduler picks up on subsequent ticks.
    if (this.blockerService && !this.routeCallbackInstalled) {
      this.installRouteCallback(sprintId)
    }

    // Emit SprintStarted. If this fails, remove the sprint from scheduler to
    // prevent a state where the scheduler has the sprint but no event was written.
    try {
      const ev: EventInput = {
        aggregate_id: sprintId,
        aggregate_type: 'sprint',
        event_type: 'SprintStarted',
        payload: {
          sprint_id: sprintId,
          commitment_id: commitmentId,
          selected_story_ids: selectedStoryIds,
          started_at: now.toISOString(),
        },
        actor,
        trace_id: traceId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      }
      await this.eventStore.append(ev)
    } catch (err) {
      // Roll back scheduler state so the sprint can be retried.
      try {
        this.scheduler.removeSprint(sprintId)
      } catch {
        // Best effort — scheduler may not have the sprint if addSprint was partial.
      }
      // Also reverse the DB status update.
      await this.db
        .update(sprints)
        .set({ status: 'ready', startedAt: null, updatedAt: new Date() })
        .where(eq(sprints.sprintId, sprintId))
        .catch(() => undefined)

      throw new OrbitalError(
        BACKLOG_ERROR_CODES.INTERNAL_DB_ERROR,
        `SprintService.start: failed to emit SprintStarted event: ${(err as Error).message}`,
        { sprintId },
      )
    }

    logger.info(
      { sprintId, taskCount: storyTasks.length, edgeCount: edges.length },
      'SprintService.start: scheduler.addSprint dispatched',
    )

    return { sprintId, startedAt: now }
  }

  // -------------------------------------------------------------------------
  // pause / resume — delegate to PauseController
  // -------------------------------------------------------------------------

  async pause(
    sprintId: string,
    reason: string,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ pausedAt: Date }> {
    if (!reason.trim()) {
      throw new OrbitalError(
        BACKLOG_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING,
        'reason is required',
      )
    }
    const traceId = uuidv7()
    const now = new Date()

    await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'sprint:' + sprintId}))`,
      )

      const rows = await tx.select().from(sprints).where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId))).limit(1)
      const sprint = rows[0]
      if (!sprint) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.NOT_FOUND_SPRINT,
          `sprint ${sprintId} not found`,
        )
      }
      if (!isValidSprintTransition(sprint.status, 'paused')) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot pause: sprint status ${sprint.status} cannot transition to paused`,
          { from: sprint.status, to: 'paused' },
        )
      }

      await tx
        .update(sprints)
        .set({ status: 'paused', pausedAt: now, updatedAt: now })
        .where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId)))
    })

    // Drain workers + revoke capabilities via PauseController
    const pauseResult = await this.pauseController.pause(sprintId, traceId)

    const ev: EventInput = {
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintPaused',
      payload: {
        sprint_id: sprintId,
        paused_at: now.toISOString(),
        in_flight_task_ids: pauseResult.drainedWorkerIds,
        reason,
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return { pausedAt: now }
  }

  async resume(
    sprintId: string,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ resumedAt: Date }> {
    const traceId = uuidv7()
    const now = new Date()

    await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'sprint:' + sprintId}))`,
      )

      const rows = await tx.select().from(sprints).where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId))).limit(1)
      const sprint = rows[0]
      if (!sprint) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.NOT_FOUND_SPRINT,
          `sprint ${sprintId} not found`,
        )
      }
      if (!isValidSprintTransition(sprint.status, 'active')) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot resume: sprint status ${sprint.status} cannot transition to active`,
          { from: sprint.status, to: 'active' },
        )
      }

      await tx
        .update(sprints)
        .set({ status: 'active', pausedAt: null, updatedAt: now })
        .where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId)))
    })

    // Re-issue capabilities via PauseController
    await this.pauseController.resume(sprintId, traceId)

    const ev: EventInput = {
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintResumed',
      payload: {
        sprint_id: sprintId,
        resumed_at: now.toISOString(),
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return { resumedAt: now }
  }

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  async complete(
    sprintId: string,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ completedAt: Date }> {
    const traceId = uuidv7()
    const now = new Date()

    const sprintRow = await this.db.transaction(async (tx) => {
      await tx.execute(
        dSQL`SELECT pg_advisory_xact_lock(hashtext(${'sprint:' + sprintId}))`,
      )

      const rows = await tx.select().from(sprints).where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId))).limit(1)
      const sprint = rows[0]
      if (!sprint) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.NOT_FOUND_SPRINT,
          `sprint ${sprintId} not found`,
        )
      }

      // Allow completing from active, completing, or paused
      const allowedFrom: SprintStatus[] = ['active', 'completing', 'paused']
      if (!allowedFrom.includes(sprint.status)) {
        throw new OrbitalError(
          BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION,
          `cannot complete: sprint status ${sprint.status} not in [${allowedFrom.join(',')}]`,
          { from: sprint.status, to: 'completed' },
        )
      }

      await tx
        .update(sprints)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId)))
      return sprint
    })

    // Remove from scheduler
    this.scheduler.removeSprint(sprintId)
    this.uninstallRouteCallback()

    // Build a story_outcomes summary from sprint_commitments + tasks (best-effort)
    const cRows = await this.db
      .select()
      .from(sprintCommitments)
      .where(eq(sprintCommitments.sprintId, sprintId))
      .limit(1)
    const commitment = cRows[0]

    const outcomes: Array<{
      story_id: string
      final_status: 'accepted' | 'defective' | 'deferred'
    }> = []
    if (commitment) {
      for (const sid of commitment.selectedStoryIds) {
        // Default to deferred; UAT integration in Phase 5A will compute real outcomes
        outcomes.push({ story_id: sid, final_status: 'deferred' })
      }
    }

    const ev: EventInput = {
      aggregate_id: sprintId,
      aggregate_type: 'sprint',
      event_type: 'SprintCompleted',
      payload: {
        sprint_id: sprintId,
        completed_at: now.toISOString(),
        story_outcomes: outcomes,
        capacity_used_points: commitment?.capacityUsedPoints ?? 0,
        budget_used_usd_cents: 0,
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    logger.info({ sprintId, prior_status: sprintRow.status }, 'SprintService.complete')

    return { completedAt: now }
  }

  // -------------------------------------------------------------------------
  // Read-side
  // -------------------------------------------------------------------------

  async list(filter: { status?: SprintStatus } = {}, tenantId: string = SENTINEL_TENANT): Promise<SprintRow[]> {
    const conditions: ReturnType<typeof eq>[] = [eq(sprints.tenantId, tenantId)]
    if (filter.status) conditions.push(eq(sprints.status, filter.status))
    const where = and(...conditions)
    return await this.db.select().from(sprints).where(where).orderBy(dSQL`sequence DESC`)
  }

  async get(sprintId: string, tenantId: string = SENTINEL_TENANT): Promise<SprintRow | null> {
    const rows = await this.db.select().from(sprints).where(and(eq(sprints.sprintId, sprintId), eq(sprints.tenantId, tenantId))).limit(1)
    return rows[0] ?? null
  }

  // -------------------------------------------------------------------------
  // Private: BlockerService onRoute wiring
  // -------------------------------------------------------------------------

  private installRouteCallback(sprintId: string): void {
    if (!this.blockerService) return

    this.blockerService.setOnRoute(async ({ resolverRole, resolverTaskId, raisingTaskId }) => {
      try {
        // Look up the raising task to inherit sprint context
        const raisingRows = await this.db
          .select()
          .from(tasks)
          .where(eq(tasks.taskId, raisingTaskId))
          .limit(1)
        const raising = raisingRows[0]
        if (!raising) {
          logger.warn({ raisingTaskId }, 'SprintService.onRoute: raising task not found; skipping')
          return
        }

        // Verify the sprint is still active before persisting the resolver task
        const sRows = await this.db
          .select({ status: sprints.status })
          .from(sprints)
          .where(eq(sprints.sprintId, raising.sprintId))
          .limit(1)
        if (!sRows[0] || sRows[0].status !== 'active') {
          logger.info(
            { sprintId: raising.sprintId, status: sRows[0]?.status },
            'SprintService.onRoute: sprint not active; skipping resolver task',
          )
          return
        }

        // Persist a real resolver task. Scheduler.tick() will pick it up.
        await this.db.insert(tasks).values({
          taskId: resolverTaskId,
          sprintId: raising.sprintId,
          ticketId: `BLOCKER-${resolverTaskId.slice(0, 8)}`,
          title: `Resolver task for blocker (${resolverRole})`,
          description: `Resolver synthesized by BlockerService for raising task ${raisingTaskId}`,
          acceptanceCriteria: [],
          personaId: resolverRole,
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

        logger.debug(
          { resolverTaskId, raisingTaskId, sprintId: raising.sprintId },
          'SprintService.onRoute: resolver task persisted',
        )
      } catch (err) {
        logger.error({ err, resolverTaskId }, 'SprintService.onRoute: failed to persist resolver task')
      }
    })

    this.routeCallbackInstalled = true
    logger.debug({ sprintId }, 'SprintService.installRouteCallback: BlockerService.setOnRoute bound')
  }

  private uninstallRouteCallback(): void {
    if (!this.blockerService || !this.routeCallbackInstalled) return
    this.blockerService.setOnRoute(undefined)
    this.routeCallbackInstalled = false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a TRD-02 priority class to the 1..5 scheduler priority weight.
 */
export function priorityClassToWeight(
  cls: SprintPriorityClass,
): 1 | 2 | 3 | 4 | 5 {
  if (cls === 'critical') return 5
  if (cls === 'standard') return 3
  return 1
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSprintService(
  db: DB,
  eventStore: EventStore,
  scheduler: Scheduler,
  pauseController: PauseController,
  options: SprintServiceOptions = {},
): SprintService {
  return new DefaultSprintService(db, eventStore, scheduler, pauseController, options)
}
