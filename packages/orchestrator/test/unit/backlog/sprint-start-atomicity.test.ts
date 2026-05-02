/**
 * sprint-start-atomicity.test.ts — Verifies that scheduler.addSprint and
 * SprintStarted event emission are atomic (all-or-nothing).
 *
 * Gap O6: SprintService.start atomic transaction.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultSprintService } from '../../../src/backlog/sprint-service.js'
import { sprints, sprintCommitments, epics, stories } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'
import type { Scheduler } from '../../../src/orchestration/scheduler.js'
import type { PauseController, PauseResult, ResumeResult } from '../../../src/orchestration/pause.js'
import { OrbitalError } from '@orbital/types'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class ThrowingScheduler implements Scheduler {
  addSprint(): void {
    throw new Error('scheduler full — ceiling reached')
  }
  removeSprint(): void { /* no-op */ }
  async tick(): Promise<void> { /* no-op */ }
  async pause(): Promise<void> { /* no-op */ }
  async resume(): Promise<void> { /* no-op */ }
  getDeficitFor(): number { return 0 }
}

class NopScheduler implements Scheduler {
  public addedSprints: string[] = []
  public removedSprints: string[] = []
  addSprint(s: { sprintId: string }): void { this.addedSprints.push(s.sprintId) }
  removeSprint(sprintId: string): void { this.removedSprints.push(sprintId) }
  async tick(): Promise<void> { /* no-op */ }
  async pause(): Promise<void> { /* no-op */ }
  async resume(): Promise<void> { /* no-op */ }
  getDeficitFor(): number { return 0 }
}

class FakePauseController implements Pick<PauseController, 'pause' | 'resume' | 'isPaused'> {
  async pause(): Promise<PauseResult> {
    return { drainedWorkerIds: [], revokedCapabilityIds: [] }
  }
  async resume(): Promise<ResumeResult> {
    return { reissuedCapabilityCount: 0, resumedTaskIds: [] }
  }
  async isPaused(): Promise<boolean> { return false }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createReadySprint(
  eventStore: ReturnType<typeof createEventStore>,
  svc: DefaultSprintService,
): Promise<string> {
  const actor = { type: 'system' as const, component: 'orchestrator' as const }

  // Create a real story so selected_story_ids is non-empty (schema requires min(1)).
  const epicId = uuidv7()
  const storyId = uuidv7()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: `Test Epic ${epicId.slice(0, 8)}`,
    rationale: 'test rationale',
    priority: 1,
    status: 'draft',
  })
  await db.insert(stories).values({
    storyId,
    epicId,
    title: `Test Story ${storyId.slice(0, 8)}`,
    description: 'test',
    status: 'ready',
    priority: 1,
    storyPoints: 1,
  })

  const sprint = await svc.create(
    { name: `Sprint ${uuidv7()}`, story_point_capacity: 10, budget_usd_cents: 10000 },
    actor,
  )
  const sprintId = sprint.sprintId

  await svc.createCommitment(
    {
      sprint_id: sprintId,
      selected_story_ids: [storyId],
      capacity_used_points: 1,
    },
    actor,
  )

  return sprintId
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let eventStore: ReturnType<typeof createEventStore>

beforeEach(() => {
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

describe('SprintService.start — atomicity', () => {
  it('rolls back DB status to ready when scheduler.addSprint throws', async () => {
    const scheduler = new ThrowingScheduler()
    const svc = new DefaultSprintService(
      db,
      eventStore,
      scheduler as unknown as Scheduler,
      new FakePauseController() as unknown as PauseController,
      { maxActiveSprints: 10_000 },
    )

    const sprintId = await createReadySprint(eventStore, svc)

    // Attempt to start — scheduler throws
    await expect(svc.start(sprintId)).rejects.toThrow(OrbitalError)

    // Sprint should be back to 'ready' not 'active'
    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId)).limit(1)
    expect(row?.status).toBe('ready')

    // No SprintStarted event should exist
    const evs = await db
      .select()
      .from(events)
      .where(
        eq(events.aggregateId, sprintId),
      )
    const startedEvent = evs.find((e) => e.eventType === 'SprintStarted')
    expect(startedEvent).toBeUndefined()
  })

  it('when scheduler.addSprint succeeds, SprintStarted event is written and sprint is active', async () => {
    const scheduler = new NopScheduler()
    const svc = new DefaultSprintService(
      db,
      eventStore,
      scheduler as unknown as Scheduler,
      new FakePauseController() as unknown as PauseController,
      { maxActiveSprints: 10_000 },
    )

    const sprintId = await createReadySprint(eventStore, svc)

    const result = await svc.start(sprintId)
    expect(result.sprintId).toBe(sprintId)

    // Sprint should now be active
    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId)).limit(1)
    expect(row?.status).toBe('active')

    // Scheduler received the sprint
    expect(scheduler.addedSprints).toContain(sprintId)

    // SprintStarted event exists
    const evs = await db.select().from(events).where(eq(events.aggregateId, sprintId))
    const startedEvent = evs.find((e) => e.eventType === 'SprintStarted')
    expect(startedEvent).toBeDefined()
  })

  it('when scheduler.addSprint succeeds but removeSprint is called on cleanup, sprint is marked ready again', async () => {
    // Simulate the scheduler succeeding initially but then being removed on event-append failure.
    // We test the rollback path by verifying that if something goes wrong after addSprint,
    // removeSprint is called. This is simulated by overriding event store.
    const scheduler = new NopScheduler()

    // Create a broken event store that always throws on append
    const brokenEventStore = {
      ...eventStore,
      append: async () => {
        throw new Error('DB connection lost')
      },
      query: eventStore.query.bind(eventStore),
      subscribe: eventStore.subscribe.bind(eventStore),
    }

    // First, set up the sprint with the real event store
    const setupSvc = new DefaultSprintService(
      db,
      eventStore,
      new NopScheduler() as unknown as Scheduler,
      new FakePauseController() as unknown as PauseController,
      { maxActiveSprints: 10_000 },
    )
    const sprintId = await createReadySprint(eventStore, setupSvc)

    // Now try to start with the broken event store
    const failSvc = new DefaultSprintService(
      db,
      brokenEventStore as typeof eventStore,
      scheduler as unknown as Scheduler,
      new FakePauseController() as unknown as PauseController,
      { maxActiveSprints: 10_000 },
    )

    await expect(failSvc.start(sprintId)).rejects.toThrow()

    // Sprint should be rolled back to ready
    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId)).limit(1)
    expect(row?.status).toBe('ready')

    // Scheduler should have received a removeSprint call
    expect(scheduler.removedSprints).toContain(sprintId)
  })
})
