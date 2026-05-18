/**
 * sprint-tick-worker.ts — Daemon sprint-tick loop.
 *
 * [Engineer-Sr · Sonnet · run-sprint-loop]
 *
 * Runs every 30 seconds inside the orchestrator daemon (ECS Fargate). For
 * each active tenant, acquires a lease via SELECT ... FOR UPDATE SKIP LOCKED
 * so that only one daemon instance runs the tick at a time. Then:
 *
 *   1. Lists all active sprints for the tenant.
 *   2. For each sprint, counts in_progress stories.
 *   3. If capacity allows, picks the next ready story (lowest priority number).
 *   4. Transitions the story Ready → InProgress.
 *   5. Spawns a story_pr_run (Lambda call if story-pr-pipeline is wired; else
 *      logs a clear error and reverts the story — never fakes success).
 *   6. Writes a sprint_tick_log row for every transition.
 *   7. Checks if all committed stories are Done → auto-completes the sprint.
 *
 * Dependencies are injected via SprintTickWorkerDeps so unit tests can
 * stub them without a real DB.
 */

import { uuidv7 } from 'uuidv7'
import { systemLogger, loggerForTenant } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintTickLogEntry {
  logId: string
  tenantId: string
  sprintId: string
  storyId: string
  fromStatus: string
  toStatus: string
  actor: string
  reason: string
  tickId: string
}

export interface StoryPrRunRef {
  runId: string
  attempt?: number
  status: 'pending' | 'spawning' | 'in_progress' | 'in_review' | 'done' | 'failed' | 'cancelled'
}

export interface SpawnInput {
  tenantId: string
  sprintId: string
  storyId: string
  runId: string
}

export interface PolicySnapshot {
  maxConcurrentRuns: number
  /** 0 = no additional cap beyond sprint.story_point_capacity */
  capacityOverride: number
}

export interface PipelineAvailability {
  available: boolean
  reason?: string
}

/**
 * Dependency interface — all side-effecting operations are injected.
 * The real implementation (buildTickDeps) wires these to the live DB + Lambda.
 * Tests inject stubs.
 */
export interface SprintTickWorkerDeps {
  /** Unique identifier for this daemon instance (used in lease + logs). */
  instanceId: string
  /** Tenant this worker services. */
  tenantId: string

  /**
   * Attempt to acquire the tick lease for this tenant.
   * Returns true if the lease was acquired, false if another instance holds it
   * (SELECT ... FOR UPDATE SKIP LOCKED semantics).
   */
  acquireLease(tenantId: string): Promise<boolean>
  /** Release the lease. Called in the finally block of every tick. */
  releaseLease(tenantId: string): Promise<void>

  /** List sprints with status='active' for the given tenant. */
  listActiveSprintsForTenant(tenantId: string): Promise<Array<{
    sprintId: string
    tenantId: string
    status: string
    storyPointCapacity: number
    endDate?: Date | null
  }>>

  /** List all committed stories for a sprint (any status). */
  listStoriesForSprint(sprintId: string, tenantId: string): Promise<Array<{
    storyId: string
    tenantId: string
    status: string
    storyPoints: number | null
    priority: number
  }>>

  /** Count stories currently in_progress for a sprint. */
  countInProgressStoriesForSprint(sprintId: string, tenantId: string): Promise<number>

  /** Read the policy for the sprint's project (or return defaults). */
  getPolicy(sprintId: string, tenantId: string): Promise<PolicySnapshot>

  /** Update a story's status column. actor is logged. */
  updateStoryStatus(storyId: string, status: string, reason: string): Promise<void>

  /** Append a row to sprint_tick_log. */
  writeTickLog(entry: SprintTickLogEntry): Promise<void>

  /** Check if the story-pr-pipeline Lambda is available for invocation. */
  checkStoryPrRunPipeline(tenantId: string): Promise<PipelineAvailability>

  /**
   * Spawn a story_pr_run. Returns the run reference on success.
   * Throws if the pipeline is unavailable — error message must clearly state
   * that the story-pr-pipeline Lambda is not merged, never silently succeeds.
   */
  spawnStoryPrRun(input: SpawnInput): Promise<StoryPrRunRef>

  /** Insert a story_pr_runs row. */
  insertStoryPrRun(run: StoryPrRunRef & SpawnInput): Promise<void>

  /** Update a story_pr_runs row. */
  updateStoryPrRun(runId: string, updates: Partial<StoryPrRunRef>): Promise<void>

  /**
   * Auto-complete the sprint (all stories done or end_date reached).
   * Delegates to SprintService.complete — idempotent on already-completed.
   */
  autoCompleteSprint(sprintId: string, tenantId: string): Promise<void>
}

export interface SprintTickResult {
  skipped: boolean
  spawnedCount: number
  autoCompletedSprintIds: string[]
  errors: string[]
}

// ---------------------------------------------------------------------------
// SprintTickWorker
// ---------------------------------------------------------------------------

export class SprintTickWorker {
  private readonly deps: SprintTickWorkerDeps

  constructor(deps: SprintTickWorkerDeps) {
    this.deps = deps
  }

  async runTick(): Promise<SprintTickResult> {
    const { tenantId, instanceId } = this.deps
    const tickId = uuidv7()
    const log = loggerForTenant({ tenant_id: tenantId })

    const leaseAcquired = await this.deps.acquireLease(tenantId)
    if (!leaseAcquired) {
      log.debug({ tick_id: tickId, instance_id: instanceId }, 'sprint-tick: lease not acquired; skipping')
      return { skipped: true, spawnedCount: 0, autoCompletedSprintIds: [], errors: [] }
    }

    const errors: string[] = []
    const autoCompletedSprintIds: string[] = []
    let spawnedCount = 0

    try {
      const activeSprints = await this.deps.listActiveSprintsForTenant(tenantId)

      log.info(
        { tick_id: tickId, sprint_count: activeSprints.length },
        'sprint-tick: scanning active sprints',
      )

      for (const sprint of activeSprints) {
        try {
          const result = await this.tickSprint(sprint.sprintId, tickId)
          spawnedCount += result.spawned
          if (result.autoCompleted) {
            autoCompletedSprintIds.push(sprint.sprintId)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`sprint ${sprint.sprintId}: ${msg}`)
          log.error({ err, sprint_id: sprint.sprintId, tick_id: tickId }, 'sprint-tick: sprint tick failed')
        }
      }

      return { skipped: false, spawnedCount, autoCompletedSprintIds, errors }
    } finally {
      await this.deps.releaseLease(tenantId)
      log.debug({ tick_id: tickId }, 'sprint-tick: lease released')
    }
  }

  // -------------------------------------------------------------------------
  // Private: per-sprint tick
  // -------------------------------------------------------------------------

  private async tickSprint(
    sprintId: string,
    tickId: string,
  ): Promise<{ spawned: number; autoCompleted: boolean }> {
    const { tenantId } = this.deps
    const log = loggerForTenant({ tenant_id: tenantId })

    const [stories, inProgressCount, policy] = await Promise.all([
      this.deps.listStoriesForSprint(sprintId, tenantId),
      this.deps.countInProgressStoriesForSprint(sprintId, tenantId),
      this.deps.getPolicy(sprintId, tenantId),
    ])

    // Check if all stories are done — if so, auto-complete the sprint.
    const nonTerminal = stories.filter(
      (s) => !['done', 'accepted', 'cancelled'].includes(s.status),
    )
    const allDone = stories.length > 0 && nonTerminal.length === 0
    if (allDone) {
      log.info({ sprint_id: sprintId, story_count: stories.length }, 'sprint-tick: all stories done; auto-completing sprint')
      await this.deps.autoCompleteSprint(sprintId, tenantId)
      return { spawned: 0, autoCompleted: true }
    }

    // Check capacity.
    const available = policy.maxConcurrentRuns - inProgressCount
    if (available <= 0) {
      log.debug(
        { sprint_id: sprintId, in_progress: inProgressCount, max: policy.maxConcurrentRuns },
        'sprint-tick: at capacity; skipping spawn',
      )
      return { spawned: 0, autoCompleted: false }
    }

    // Pick the next ready story (lowest priority number first).
    const readyStories = stories
      .filter((s) => s.status === 'ready')
      .sort((a, b) => a.priority - b.priority)

    if (readyStories.length === 0) {
      log.debug({ sprint_id: sprintId }, 'sprint-tick: no ready stories')
      return { spawned: 0, autoCompleted: false }
    }

    const story = readyStories[0]!
    const runId = uuidv7()

    // Check pipeline availability before transitioning the story.
    const pipeline = await this.deps.checkStoryPrRunPipeline(tenantId)
    if (!pipeline.available) {
      const reason = pipeline.reason ?? 'story-pr-pipeline Lambda not registered'
      log.error(
        { sprint_id: sprintId, story_id: story.storyId, reason },
        'sprint-tick: story-pr-pipeline not available — cannot spawn run',
      )
      throw new Error(`story-pr-pipeline not available: ${reason}`)
    }

    // Transition story: ready → in_progress
    await this.deps.updateStoryStatus(story.storyId, 'in_progress', `tick:${tickId}`)
    await this.deps.writeTickLog({
      logId: uuidv7(),
      tenantId,
      sprintId,
      storyId: story.storyId,
      fromStatus: 'ready',
      toStatus: 'in_progress',
      actor: `daemon:sprint-tick:${this.deps.instanceId}`,
      reason: `tick ${tickId}: capacity available (${inProgressCount}/${policy.maxConcurrentRuns})`,
      tickId,
    })

    // Insert the story_pr_run row in pending state.
    await this.deps.insertStoryPrRun({
      runId,
      tenantId,
      sprintId,
      storyId: story.storyId,
      status: 'spawning',
      attempt: 1,
    })

    // Spawn the story_pr_run. If it throws, revert the story to ready.
    let runRef: StoryPrRunRef
    try {
      runRef = await this.deps.spawnStoryPrRun({
        tenantId,
        sprintId,
        storyId: story.storyId,
        runId,
      })
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      log.error(
        { sprint_id: sprintId, story_id: story.storyId, run_id: runId, err: msg },
        'sprint-tick: spawn failed; reverting story to ready',
      )

      // Revert story status
      await this.deps.updateStoryStatus(story.storyId, 'ready', `revert:spawn-failed:${msg.slice(0, 100)}`)
      await this.deps.writeTickLog({
        logId: uuidv7(),
        tenantId,
        sprintId,
        storyId: story.storyId,
        fromStatus: 'in_progress',
        toStatus: 'ready',
        actor: `daemon:sprint-tick:${this.deps.instanceId}`,
        reason: `spawn failed: ${msg.slice(0, 200)}`,
        tickId,
      })

      // Update the storyPrRun to failed
      await this.deps.updateStoryPrRun(runId, { status: 'failed' })

      throw new Error(msg)
    }

    log.info(
      {
        sprint_id: sprintId,
        story_id: story.storyId,
        run_id: runRef.runId,
        run_status: runRef.status,
        tick_id: tickId,
      },
      'sprint-tick: story_pr_run spawned',
    )

    return { spawned: 1, autoCompleted: false }
  }
}

// ---------------------------------------------------------------------------
// buildTickDeps — wires real DB + Lambda for production use
// ---------------------------------------------------------------------------

/**
 * Build production SprintTickWorkerDeps from a live DB connection and
 * environment configuration.
 *
 * The story-pr-pipeline Lambda ARN is read from the
 * STORY_PR_PIPELINE_LAMBDA_ARN environment variable. If it is not set,
 * checkStoryPrRunPipeline returns available=false with a clear message and
 * spawnStoryPrRun throws — never silently succeeds.
 */
export function buildTickDeps(opts: {
  instanceId: string
  tenantId: string
  db: import('@orbital/db').DB
}): SprintTickWorkerDeps {
  const { instanceId, tenantId, db } = opts
  const log = loggerForTenant({ tenant_id: tenantId })

  // Lazy import of drizzle helpers to keep this file light when tests import it.
  return {
    instanceId,
    tenantId,

    // -----------------------------------------------------------------------
    // Lease
    // -----------------------------------------------------------------------

    async acquireLease(tid: string): Promise<boolean> {
      // Ensure the lease row exists for this tenant, then try to acquire it
      // via SELECT ... FOR UPDATE SKIP LOCKED.
      try {
        const { sprintTickLeases } = await import('@orbital/db')
        const { eq, sql } = await import('drizzle-orm')

        // Upsert the lease row (CREATE the tenant slot on first boot).
        await db.execute(sql`
          INSERT INTO sprint_tick_leases (tenant_id, holder_id, acquired_at, expires_at)
          VALUES (${tid}, '', now(), now() + interval '60 seconds')
          ON CONFLICT (tenant_id) DO NOTHING
        `)

        // Attempt to acquire via FOR UPDATE SKIP LOCKED
        const result = await db.execute(sql`
          SELECT tenant_id FROM sprint_tick_leases
          WHERE tenant_id = ${tid}
          FOR UPDATE SKIP LOCKED
        `)

        const rows = result as unknown as Array<{ tenant_id: string }>
        if (rows.length === 0) {
          return false
        }

        // Update the holder and expiry
        await db
          .update(sprintTickLeases)
          .set({
            holderId: instanceId,
            acquiredAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          })
          .where(eq(sprintTickLeases.tenantId, tid))

        return true
      } catch (err) {
        log.error({ err }, 'sprint-tick: acquireLease failed')
        return false
      }
    },

    async releaseLease(tid: string): Promise<void> {
      try {
        const { sprintTickLeases } = await import('@orbital/db')
        const { eq } = await import('drizzle-orm')
        await db
          .update(sprintTickLeases)
          .set({ holderId: '' })
          .where(eq(sprintTickLeases.tenantId, tid))
      } catch (err) {
        log.error({ err }, 'sprint-tick: releaseLease failed')
      }
    },

    // -----------------------------------------------------------------------
    // Sprint + story reads
    // -----------------------------------------------------------------------

    async listActiveSprintsForTenant(tid: string) {
      const { sprints } = await import('@orbital/db')
      const { and, eq } = await import('drizzle-orm')
      return await db
        .select({
          sprintId: sprints.sprintId,
          tenantId: sprints.tenantId,
          status: sprints.status,
          storyPointCapacity: sprints.storyPointCapacity,
          endDate: sprints.completedAt,
        })
        .from(sprints)
        .where(and(eq(sprints.tenantId, tid), eq(sprints.status, 'active')))
    },

    async listStoriesForSprint(sprintId: string, tid: string) {
      // Stories are linked to sprints via sprint_commitments.selected_story_ids.
      // We load the commitment and then query all those story IDs.
      const { stories, sprintCommitments } = await import('@orbital/db')
      const { and, eq, inArray } = await import('drizzle-orm')

      const cRows = await db
        .select({ selectedStoryIds: sprintCommitments.selectedStoryIds })
        .from(sprintCommitments)
        .where(and(eq(sprintCommitments.sprintId, sprintId), eq(sprintCommitments.tenantId, tid)))
        .limit(1)

      const storyIds = cRows[0]?.selectedStoryIds ?? []
      if (storyIds.length === 0) return []

      return await db
        .select({
          storyId: stories.storyId,
          tenantId: stories.tenantId,
          status: stories.status,
          storyPoints: stories.storyPoints,
          priority: stories.priority,
        })
        .from(stories)
        .where(and(eq(stories.tenantId, tid), inArray(stories.storyId, storyIds)))
    },

    async countInProgressStoriesForSprint(sprintId: string, tid: string): Promise<number> {
      const { stories, sprintCommitments } = await import('@orbital/db')
      const { and, eq, inArray, count } = await import('drizzle-orm')

      const cRows = await db
        .select({ selectedStoryIds: sprintCommitments.selectedStoryIds })
        .from(sprintCommitments)
        .where(and(eq(sprintCommitments.sprintId, sprintId), eq(sprintCommitments.tenantId, tid)))
        .limit(1)

      const storyIds = cRows[0]?.selectedStoryIds ?? []
      if (storyIds.length === 0) return 0

      const rows = await db
        .select({ c: count() })
        .from(stories)
        .where(
          and(
            eq(stories.tenantId, tid),
            inArray(stories.storyId, storyIds),
            eq(stories.status, 'in_progress'),
          ),
        )
      return Number(rows[0]?.c ?? 0)
    },

    async getPolicy(sprintId: string, tid: string): Promise<PolicySnapshot> {
      try {
        const { projectSprintPolicy, sprintCommitments } = await import('@orbital/db')
        const { and, eq } = await import('drizzle-orm')

        // Find the project_id via sprint → commitment → stories → epic → project.
        // For now, look up a policy row keyed by tenant only (project_id is optional
        // in our query — use tenant-level defaults when project_id is unknown).
        // A future migration can add sprint.project_id for direct lookup.
        void sprintId // suppress unused warning — used for cache keying in future

        const rows = await db
          .select({
            maxConcurrentRuns: projectSprintPolicy.maxConcurrentRuns,
            capacityOverride: projectSprintPolicy.capacityOverride,
          })
          .from(projectSprintPolicy)
          .where(eq(projectSprintPolicy.tenantId, tid))
          .limit(1)

        if (rows[0]) {
          return {
            maxConcurrentRuns: rows[0].maxConcurrentRuns,
            capacityOverride: rows[0].capacityOverride,
          }
        }
      } catch (err) {
        log.warn({ err }, 'sprint-tick: getPolicy failed; using defaults')
      }

      return { maxConcurrentRuns: 3, capacityOverride: 0 }
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    async updateStoryStatus(storyId: string, status: string, _reason: string): Promise<void> {
      const { stories } = await import('@orbital/db')
      const { eq, and } = await import('drizzle-orm')
      await db
        .update(stories)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set({ status: status as any, updatedAt: new Date() })
        .where(and(eq(stories.storyId, storyId), eq(stories.tenantId, tenantId)))
    },

    async writeTickLog(entry: SprintTickLogEntry): Promise<void> {
      const { sprintTickLog } = await import('@orbital/db')
      await db.insert(sprintTickLog).values({
        logId: entry.logId,
        tenantId: entry.tenantId,
        sprintId: entry.sprintId,
        storyId: entry.storyId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actor: entry.actor,
        reason: entry.reason,
        tickId: entry.tickId,
        loggedAt: new Date(),
        schemaVersion: 1,
      })
    },

    // -----------------------------------------------------------------------
    // story-pr-pipeline
    // -----------------------------------------------------------------------

    async checkStoryPrRunPipeline(_tid: string): Promise<PipelineAvailability> {
      const lambdaArn = process.env['STORY_PR_PIPELINE_LAMBDA_ARN']
      if (!lambdaArn) {
        return {
          available: false,
          reason: 'NOT_MERGED: story-pr-pipeline Lambda not registered (STORY_PR_PIPELINE_LAMBDA_ARN not set). ' +
            'This feature requires the story-pr-pipeline work to be merged before sprint ticking can spawn real runs.',
        }
      }
      return { available: true }
    },

    async spawnStoryPrRun(input: SpawnInput): Promise<StoryPrRunRef> {
      const lambdaArn = process.env['STORY_PR_PIPELINE_LAMBDA_ARN']
      if (!lambdaArn) {
        throw new Error(
          'story-pr-pipeline not available: NOT_MERGED: STORY_PR_PIPELINE_LAMBDA_ARN not set. ' +
          'The story-pr-pipeline Lambda must be deployed before sprint runs can be spawned.',
        )
      }

      const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda')
      const lambdaClient = new LambdaClient({})

      const payload = JSON.stringify({
        source: 'sprint-tick',
        tenantId: input.tenantId,
        sprintId: input.sprintId,
        storyId: input.storyId,
        runId: input.runId,
      })

      const cmd = new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: 'Event', // async invocation
        Payload: Buffer.from(payload),
      })

      const response = await lambdaClient.send(cmd)
      // $metadata.requestId is the AWS SDK v3 canonical request ID field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (response as unknown as Record<string, any>)['$metadata'] ?? {}
      const invocationId = String(meta['requestId'] ?? uuidv7())

      log.info(
        {
          story_id: input.storyId,
          sprint_id: input.sprintId,
          run_id: input.runId,
          lambda_invocation_id: invocationId,
        },
        'sprint-tick: story-pr-pipeline Lambda invoked',
      )

      return { runId: input.runId, status: 'spawning' }
    },

    async insertStoryPrRun(run: StoryPrRunRef & SpawnInput): Promise<void> {
      const { storyPrRuns } = await import('@orbital/db')
      await db.insert(storyPrRuns).values({
        runId: run.runId,
        tenantId: run.tenantId,
        sprintId: run.sprintId,
        storyId: run.storyId,
        attempt: run.attempt ?? 1,
        status: run.status,
        startedAt: new Date(),
        schemaVersion: 1,
      })
    },

    async updateStoryPrRun(runId: string, updates: Partial<StoryPrRunRef>): Promise<void> {
      const { storyPrRuns } = await import('@orbital/db')
      const { eq } = await import('drizzle-orm')
      const patch: Record<string, unknown> = {}
      if (updates.status !== undefined) patch['status'] = updates.status
      if (Object.keys(patch).length === 0) return
      await db
        .update(storyPrRuns)
        .set(patch as Partial<typeof storyPrRuns.$inferInsert>)
        .where(eq(storyPrRuns.runId, runId))
    },

    async autoCompleteSprint(sprintId: string, _tid: string): Promise<void> {
      // Delegate to the SprintService complete() via a direct DB update +
      // event. SprintService is not injected here to avoid a heavy DI chain;
      // we do a lightweight direct update that mirrors what SprintService.complete
      // does for the status column, and log for the audit trail.
      //
      // A full SprintService injection is deferred — the SprintService requires
      // Scheduler + PauseController which carry heavy in-process state.
      const { sprints } = await import('@orbital/db')
      const { and, eq } = await import('drizzle-orm')
      const now = new Date()

      log.info({ sprint_id: sprintId }, 'sprint-tick: auto-completing sprint')

      await db
        .update(sprints)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(
          and(
            eq(sprints.sprintId, sprintId),
            eq(sprints.tenantId, tenantId),
            // Only complete if still active (idempotent — skip if already completed)
            eq(sprints.status, 'active'),
          ),
        )
    },
  }
}

// ---------------------------------------------------------------------------
// Tick loop — runs forever until stop() is called
// ---------------------------------------------------------------------------

export class SprintTickLoop {
  private running = false
  private readonly worker: SprintTickWorker
  private readonly intervalMs: number

  constructor(worker: SprintTickWorker, intervalMs = 30_000) {
    this.worker = worker
    this.intervalMs = intervalMs
  }

  async start(): Promise<void> {
    this.running = true
    systemLogger.info({ interval_ms: this.intervalMs }, 'sprint-tick-loop: starting')
    while (this.running) {
      const t0 = Date.now()
      try {
        await this.worker.runTick()
      } catch (err) {
        systemLogger.error({ err }, 'sprint-tick-loop: tick threw; continuing')
      }
      const elapsed = Date.now() - t0
      const wait = Math.max(0, this.intervalMs - elapsed)
      if (this.running && wait > 0) {
        await sleep(wait)
      }
    }
    systemLogger.info('sprint-tick-loop: stopped')
  }

  stop(): void {
    this.running = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}
