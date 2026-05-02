/**
 * Unit tests for SprintService.
 *
 * Tests sprint state-machine, ceiling enforcement, commitment writing, and
 * pause/resume delegation. Scheduler and PauseController are real instances
 * with stubbed external dependencies (no LLM calls; no spawned workers).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultSprintService, priorityClassToWeight } from '../../../src/backlog/sprint-service.js'
import {
  sprints,
  sprintCommitments,
  epics,
  stories,
  storyAcceptanceCriteria,
} from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'
import { isValidSprintTransition } from '../../../src/backlog/types.js'
import type { Scheduler } from '../../../src/orchestration/scheduler.js'
import type { PauseController, PauseResult, ResumeResult } from '../../../src/orchestration/pause.js'

// ---------------------------------------------------------------------------
// Fakes for Scheduler + PauseController (these are interfaces in production;
// we mock at the seam, not at HTTP / DB layer)
// ---------------------------------------------------------------------------

class FakeScheduler implements Scheduler {
  public addedSprints: Array<{ sprintId: string; priority: number }> = []
  public removedSprints: string[] = []
  addSprint(sprint: { sprintId: string; priority: number }): void {
    this.addedSprints.push(sprint)
  }
  removeSprint(sprintId: string): void {
    this.removedSprints.push(sprintId)
  }
  async tick(): Promise<void> {
    // no-op
  }
  async pause(): Promise<void> {
    // no-op
  }
  async resume(): Promise<void> {
    // no-op
  }
  getDeficitFor(): number {
    return 0
  }
}

class FakePauseController implements Pick<PauseController, 'pause' | 'resume' | 'isPaused'> {
  public paused: string[] = []
  public resumed: string[] = []
  async pause(sprintId: string): Promise<PauseResult> {
    this.paused.push(sprintId)
    return { drainedWorkerIds: [], revokedCapabilityIds: [] }
  }
  async resume(sprintId: string): Promise<ResumeResult> {
    this.resumed.push(sprintId)
    return { reissuedCapabilityCount: 0, resumedTaskIds: [] }
  }
  async isPaused(): Promise<boolean> {
    return false
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ownedSprintIds: string[] = []
const ownedEpicIds: string[] = []
let scheduler: FakeScheduler
let pauseController: FakePauseController
let sprintService: DefaultSprintService

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
  scheduler = new FakeScheduler()
  pauseController = new FakePauseController()
  const eventStore = createEventStore(db, sql)
  // Use a high ceiling so cross-test sprint accumulation doesn't trip the gate.
  // Ceiling-specific tests construct their own service with a small ceiling.
  sprintService = new DefaultSprintService(
    db,
    eventStore,
    scheduler,
    pauseController as unknown as PauseController,
    { maxActiveSprints: 10_000 },
  )
  ownedSprintIds.length = 0
  ownedEpicIds.length = 0
})

afterAll(async () => {
  // Clean up
  if (ownedSprintIds.length > 0) {
    await db.delete(sprintCommitments).where(inArray(sprintCommitments.sprintId, ownedSprintIds))
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprintIds))
  }
  if (ownedEpicIds.length > 0) {
    const sIds = await db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(inArray(stories.epicId, ownedEpicIds))
    if (sIds.length > 0) {
      await db
        .delete(storyAcceptanceCriteria)
        .where(
          inArray(
            storyAcceptanceCriteria.storyId,
            sIds.map((r) => r.storyId),
          ),
        )
      await db.delete(stories).where(inArray(stories.epicId, ownedEpicIds))
    }
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe('isValidSprintTransition', () => {
  it('allows planning -> ready', () => {
    expect(isValidSprintTransition('planning', 'ready')).toBe(true)
  })
  it('allows ready -> active and active -> paused', () => {
    expect(isValidSprintTransition('ready', 'active')).toBe(true)
    expect(isValidSprintTransition('active', 'paused')).toBe(true)
  })
  it('allows paused -> active and paused -> completed', () => {
    expect(isValidSprintTransition('paused', 'active')).toBe(true)
    expect(isValidSprintTransition('paused', 'completed')).toBe(true)
  })
  it('rejects planning -> active (must commit first)', () => {
    expect(isValidSprintTransition('planning', 'active')).toBe(false)
  })
  it('treats completed as terminal', () => {
    expect(isValidSprintTransition('completed', 'active')).toBe(false)
  })
})

describe('priorityClassToWeight', () => {
  it('maps critical=5 standard=3 background=1', () => {
    expect(priorityClassToWeight('critical')).toBe(5)
    expect(priorityClassToWeight('standard')).toBe(3)
    expect(priorityClassToWeight('background')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('SprintService.create', () => {
  it('creates a planning sprint and emits SprintCreated', async () => {
    const sprint = await sprintService.create({
      name: 'Sprint α',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
      priority_class: 'standard',
    })
    ownedSprintIds.push(sprint.sprintId)

    expect(sprint.status).toBe('planning')
    expect(sprint.storyPointCapacity).toBe(10)
    expect(sprint.priorityClass).toBe('standard')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprint.sprintId))
    expect(evRows.some((r) => r.eventType === 'SprintCreated')).toBe(true)
  })

  it('rejects when active+paused sprint count >= maxActiveSprints', async () => {
    // Count current active+paused sprints (cross-test pollution); set the
    // ceiling so we can fit exactly one more.
    const existing = await db
      .select()
      .from(sprints)
      .where(inArray(sprints.status, ['active', 'paused']))
    const ceiling = existing.length + 1

    const lowCap = new DefaultSprintService(
      db,
      createEventStore(db, sql),
      scheduler,
      pauseController as unknown as PauseController,
      { maxActiveSprints: ceiling },
    )
    const s1 = await lowCap.create({
      name: 'A',
      story_point_capacity: 5,
      budget_usd_cents: 1000,
    })
    ownedSprintIds.push(s1.sprintId)

    // Force s1 into 'active' so it counts toward the ceiling
    await db
      .update(sprints)
      .set({ status: 'active' })
      .where(eq(sprints.sprintId, s1.sprintId))

    await expect(
      lowCap.create({
        name: 'B',
        story_point_capacity: 5,
        budget_usd_cents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_SPRINT_CEILING_EXCEEDED' })
  })
})

// ---------------------------------------------------------------------------
// createCommitment
// ---------------------------------------------------------------------------

describe('SprintService.createCommitment', () => {
  it('writes commitment + transitions planning -> ready', async () => {
    const sprint = await sprintService.create({
      name: 'C-test',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
    })
    ownedSprintIds.push(sprint.sprintId)
    const storyId = uuidv7()
    await sprintService.createCommitment({
      sprint_id: sprint.sprintId,
      selected_story_ids: [storyId],
      capacity_used_points: 5,
    })
    const after = await db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprint.sprintId))
      .limit(1)
    expect(after[0]?.status).toBe('ready')
    const cRows = await db
      .select()
      .from(sprintCommitments)
      .where(eq(sprintCommitments.sprintId, sprint.sprintId))
    expect(cRows.length).toBe(1)
    expect(cRows[0]?.selectedStoryIds).toEqual([storyId])
  })

  it('rejects commitment for an unknown sprint', async () => {
    await expect(
      sprintService.createCommitment({
        sprint_id: uuidv7(),
        selected_story_ids: [uuidv7()],
        capacity_used_points: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND_SPRINT' })
  })
})

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('SprintService.start', () => {
  it('starts a ready sprint and calls Scheduler.addSprint', async () => {
    const sprint = await sprintService.create({
      name: 'start-test',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
      priority_class: 'critical',
    })
    ownedSprintIds.push(sprint.sprintId)
    const storyId = uuidv7()
    await sprintService.createCommitment({
      sprint_id: sprint.sprintId,
      selected_story_ids: [storyId],
      capacity_used_points: 5,
    })

    const result = await sprintService.start(sprint.sprintId)
    expect(result.sprintId).toBe(sprint.sprintId)
    expect(result.startedAt).toBeInstanceOf(Date)

    expect(scheduler.addedSprints.length).toBe(1)
    expect(scheduler.addedSprints[0]?.sprintId).toBe(sprint.sprintId)
    // critical priority class -> weight 5
    expect(scheduler.addedSprints[0]?.priority).toBe(5)

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprint.sprintId))
    expect(evRows.some((r) => r.eventType === 'SprintStarted')).toBe(true)
  })

  it('rejects start without a commitment', async () => {
    const sprint = await sprintService.create({
      name: 'no-commit',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
    })
    ownedSprintIds.push(sprint.sprintId)
    // The sprint is in 'planning'; planning -> active is not a legal transition
    // (must commit first to reach 'ready'). Surface as CONFLICT_INVALID_STATE_TRANSITION.
    await expect(sprintService.start(sprint.sprintId)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE_TRANSITION',
    })
  })
})

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

describe('SprintService.pause / resume', () => {
  async function bringSprintActive(): Promise<string> {
    const sprint = await sprintService.create({
      name: 'pr',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
    })
    ownedSprintIds.push(sprint.sprintId)
    await sprintService.createCommitment({
      sprint_id: sprint.sprintId,
      selected_story_ids: [uuidv7()],
      capacity_used_points: 5,
    })
    await sprintService.start(sprint.sprintId)
    return sprint.sprintId
  }

  it('pauses an active sprint, delegates to PauseController, emits SprintPaused', async () => {
    const sprintId = await bringSprintActive()
    const result = await sprintService.pause(sprintId, 'maintenance window')
    expect(result.pausedAt).toBeInstanceOf(Date)
    expect(pauseController.paused).toContain(sprintId)

    const after = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId))
    expect(after[0]?.status).toBe('paused')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprintId))
    expect(evRows.some((r) => r.eventType === 'SprintPaused')).toBe(true)
  })

  it('rejects pause without reason', async () => {
    const sprintId = await bringSprintActive()
    await expect(sprintService.pause(sprintId, '')).rejects.toMatchObject({
      code: 'VALIDATION_REQUIRED_FIELD_MISSING',
    })
  })

  it('resumes a paused sprint and delegates to PauseController', async () => {
    const sprintId = await bringSprintActive()
    await sprintService.pause(sprintId, 'r')
    const result = await sprintService.resume(sprintId)
    expect(result.resumedAt).toBeInstanceOf(Date)
    expect(pauseController.resumed).toContain(sprintId)

    const after = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId))
    expect(after[0]?.status).toBe('active')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprintId))
    expect(evRows.some((r) => r.eventType === 'SprintResumed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

describe('SprintService.complete', () => {
  it('completes an active sprint and removes it from the scheduler', async () => {
    const sprint = await sprintService.create({
      name: 'complete-test',
      story_point_capacity: 10,
      budget_usd_cents: 50000,
    })
    ownedSprintIds.push(sprint.sprintId)
    await sprintService.createCommitment({
      sprint_id: sprint.sprintId,
      selected_story_ids: [uuidv7()],
      capacity_used_points: 5,
    })
    await sprintService.start(sprint.sprintId)
    const result = await sprintService.complete(sprint.sprintId)
    expect(result.completedAt).toBeInstanceOf(Date)
    expect(scheduler.removedSprints).toContain(sprint.sprintId)

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprint.sprintId))
    expect(evRows.some((r) => r.eventType === 'SprintCompleted')).toBe(true)
  })
})
