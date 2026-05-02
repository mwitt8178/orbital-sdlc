/**
 * Integration test: end-to-end sprint lifecycle.
 *
 * Real Postgres. Real BacklogService, SprintService, EventStore. The Scheduler
 * is observed via a recorder fake — we verify Scheduler.addSprint is called
 * with the correct DAG-derived priority, and verify SprintStarted is emitted.
 *
 * Per Phase 4B brief: "create epic → story → sprint → start → SprintStarted
 * event + Scheduler.addSprint called".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { DefaultSprintService } from '../../../src/backlog/sprint-service.js'
import {
  sprints,
  sprintCommitments,
  epics,
  stories,
  storyAcceptanceCriteria,
} from '../../../src/db/schema/backlog.js'
import { tasks, taskDependencies } from '../../../src/db/schema/orchestration.js'
import { events } from '../../../src/db/schema/events.js'
import type { Scheduler } from '../../../src/orchestration/scheduler.js'
import type {
  PauseController,
  PauseResult,
  ResumeResult,
} from '../../../src/orchestration/pause.js'

// ---------------------------------------------------------------------------
// Fakes for Scheduler / PauseController boundary
// ---------------------------------------------------------------------------

class RecordingScheduler implements Scheduler {
  public addedSprints: Array<{ sprintId: string; priority: number }> = []
  public removedSprints: string[] = []
  addSprint(s: { sprintId: string; priority: number }): void {
    this.addedSprints.push(s)
  }
  removeSprint(id: string): void {
    this.removedSprints.push(id)
  }
  async tick(): Promise<void> {
    return
  }
  async pause(): Promise<void> {
    return
  }
  async resume(): Promise<void> {
    return
  }
  getDeficitFor(): number {
    return 0
  }
}

class FakePauseController implements Pick<PauseController, 'pause' | 'resume' | 'isPaused'> {
  async pause(): Promise<PauseResult> {
    return { drainedWorkerIds: [], revokedCapabilityIds: [] }
  }
  async resume(): Promise<ResumeResult> {
    return { reissuedCapabilityCount: 0, resumedTaskIds: [] }
  }
  async isPaused(): Promise<boolean> {
    return false
  }
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []
const ownedSprintIds: string[] = []
const ownedTaskIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  if (ownedTaskIds.length > 0) {
    await db
      .delete(taskDependencies)
      .where(inArray(taskDependencies.predecessorTaskId, ownedTaskIds))
    await db.delete(tasks).where(inArray(tasks.taskId, ownedTaskIds))
  }
  if (ownedSprintIds.length > 0) {
    await db.delete(sprintCommitments).where(inArray(sprintCommitments.sprintId, ownedSprintIds))
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprintIds))
  }
  if (ownedStoryIds.length > 0) {
    await db
      .delete(storyAcceptanceCriteria)
      .where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds))
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds))
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sprint lifecycle: epic → story → sprint → start', () => {
  it('builds a real DAG from sprint commitment + tasks and dispatches to Scheduler.addSprint', async () => {
    const eventStore = createEventStore(db, sql)
    const backlog = new DefaultBacklogService(db, eventStore)
    const scheduler = new RecordingScheduler()
    const pauseController = new FakePauseController()
    const sprintService = new DefaultSprintService(
      db,
      eventStore,
      scheduler,
      pauseController as unknown as PauseController,
      { maxActiveSprints: 10_000 },
    )

    // 1. Create epic
    const epic = await backlog.createEpic({
      vision_version_id: uuidv7(),
      title: 'Customer billing',
      rationale: 'critical',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    // 2. Create stories
    const story1 = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'Story 1',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story1.storyId)

    const story2 = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'Story 2',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story2.storyId)

    // 3. Create sprint
    const sprint = await sprintService.create({
      name: 'Sprint One',
      story_point_capacity: 20,
      budget_usd_cents: 100000,
      priority_class: 'critical',
    })
    ownedSprintIds.push(sprint.sprintId)

    // 4. Commit stories to the sprint (transitions planning -> ready)
    await sprintService.createCommitment({
      sprint_id: sprint.sprintId,
      selected_story_ids: [story1.storyId, story2.storyId],
      capacity_used_points: 13,
    })

    // 5. Insert real tasks for these stories with dependencies between them
    const taskA = uuidv7()
    const taskB = uuidv7()
    ownedTaskIds.push(taskA, taskB)

    await db.insert(tasks).values([
      {
        taskId: taskA,
        sprintId: sprint.sprintId,
        ticketId: `T-${taskA.slice(0, 8)}`,
        title: 'task A',
        description: 'd',
        acceptanceCriteria: [],
        storyId: story1.storyId,
        personaId: 'sr-dev',
        riskClass: 'standard',
        state: 'pending',
        attemptCount: 0,
        retryBudget: 3,
        wallClockTimeoutMs: 60_000,
        tokenBudget: 4000,
        tokensConsumed: 0,
        declaredWritePaths: [],
        createdByEventId: uuidv7(),
      },
      {
        taskId: taskB,
        sprintId: sprint.sprintId,
        ticketId: `T-${taskB.slice(0, 8)}`,
        title: 'task B',
        description: 'd',
        acceptanceCriteria: [],
        storyId: story2.storyId,
        personaId: 'sr-dev',
        riskClass: 'standard',
        state: 'pending',
        attemptCount: 0,
        retryBudget: 3,
        wallClockTimeoutMs: 60_000,
        tokenBudget: 4000,
        tokensConsumed: 0,
        declaredWritePaths: [],
        createdByEventId: uuidv7(),
      },
    ])

    // taskA must complete before taskB (blocking edge)
    await db.insert(taskDependencies).values({
      predecessorTaskId: taskA,
      successorTaskId: taskB,
      dependencyType: 'explicit',
      blocking: true,
      rationale: 'integration test edge',
    })

    // 6. Start the sprint
    const result = await sprintService.start(sprint.sprintId)
    expect(result.sprintId).toBe(sprint.sprintId)
    expect(result.startedAt).toBeInstanceOf(Date)

    // Scheduler.addSprint must have been called with priority=5 (critical)
    expect(scheduler.addedSprints.length).toBe(1)
    expect(scheduler.addedSprints[0]?.sprintId).toBe(sprint.sprintId)
    expect(scheduler.addedSprints[0]?.priority).toBe(5)

    // SprintStarted event written
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sprint.sprintId))
    const startedEv = evRows.find((r) => r.eventType === 'SprintStarted')
    expect(startedEv).toBeDefined()
    const payload = startedEv?.payload as {
      sprint_id: string
      commitment_id: string
      selected_story_ids: string[]
    }
    expect(payload.sprint_id).toBe(sprint.sprintId)
    expect(payload.selected_story_ids).toContain(story1.storyId)
    expect(payload.selected_story_ids).toContain(story2.storyId)

    // 7. Pause / resume / complete cycle
    await sprintService.pause(sprint.sprintId, 'manual test pause')
    const pausedRow = await db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprint.sprintId))
    expect(pausedRow[0]?.status).toBe('paused')

    await sprintService.resume(sprint.sprintId)
    const resumedRow = await db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprint.sprintId))
    expect(resumedRow[0]?.status).toBe('active')

    await sprintService.complete(sprint.sprintId)
    expect(scheduler.removedSprints).toContain(sprint.sprintId)
    const completedRow = await db
      .select()
      .from(sprints)
      .where(eq(sprints.sprintId, sprint.sprintId))
    expect(completedRow[0]?.status).toBe('completed')
  }, 30_000)
})
