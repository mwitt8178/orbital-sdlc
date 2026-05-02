/**
 * iteration-limit.integration.test.ts
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Acceptance criterion #3:
 *   - 4th defect on a task with iteration_count=3 → emits DefectIterationLimitReached
 *   - Task state remains in_review (NOT re-opened)
 *   - No TaskReopenedForDefect event emitted
 *
 * Real Postgres. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { onDefectReported, ITERATION_LIMIT } from '../../../src/hooks/post-defect-reported.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { epics, stories, storyAcceptanceCriteria, sprints } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

const cleanup = {
  taskIds: [] as string[],
  storyIds: [] as string[],
  epicIds: [] as string[],
  sprintIds: [] as string[],
}

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  if (cleanup.taskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.taskId, cleanup.taskIds)).catch(() => undefined)
  }
  if (cleanup.storyIds.length > 0) {
    await db.delete(storyAcceptanceCriteria).where(inArray(storyAcceptanceCriteria.storyId, cleanup.storyIds)).catch(() => undefined)
    await db.delete(stories).where(inArray(stories.storyId, cleanup.storyIds)).catch(() => undefined)
  }
  if (cleanup.epicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, cleanup.epicIds)).catch(() => undefined)
  }
  if (cleanup.sprintIds.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, cleanup.sprintIds)).catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

async function seedTaskAtLimit(): Promise<{ taskId: string }> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const sprintId = uuidv7()
  const taskId = uuidv7()

  const now = new Date()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'Limit test epic',
    rationale: 'test',
    priority: 1001,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  await db.insert(stories).values({
    storyId,
    epicId,
    title: 'Limit test story',
    description: 'desc',
    status: 'in_review',
    priority: 1,
    storyPoints: 2,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  await db.insert(sprints).values({
    sprintId,
    name: 'Limit test sprint',
    sequence: 9002,
    status: 'active',
    storyPointCapacity: 10,
    budgetUsdCents: 10_000,
    concurrencyShare: 100,
    priorityClass: 'standard',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  const createdByEventId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: storyId,
    storyId,
    title: 'Task at iteration limit',
    description: 'Task description',
    acceptanceCriteria: [],
    personaId: 'engineer',
    riskClass: 'standard',
    // Already at the iteration limit
    state: 'in_review',
    attemptCount: 0,
    retryBudget: 3,
    wallClockTimeoutMs: 300_000,
    tokenBudget: 50_000,
    linkedArtifacts: [],
    declaredWritePaths: [],
    createdAt: now,
    createdByEventId,
    iterationCount: ITERATION_LIMIT, // already at limit
    schemaVersion: 1,
  })

  cleanup.taskIds.push(taskId)
  cleanup.storyIds.push(storyId)
  cleanup.epicIds.push(epicId)
  cleanup.sprintIds.push(sprintId)

  return { taskId }
}

describe('iteration-limit: 4th defect emits DefectIterationLimitReached, no re-spawn', () => {
  it('emits DefectIterationLimitReached and does NOT change task state', async () => {
    const eventStore = createEventStore(db, sql)
    const { taskId } = await seedTaskAtLimit()
    const defectId = uuidv7()
    const acId = uuidv7()

    const stateBeforeCount = await db
      .select({ state: tasks.state, iterationCount: tasks.iterationCount })
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .limit(1)
    const stateBefore = stateBeforeCount[0]!

    expect(stateBefore.iterationCount).toBe(ITERATION_LIMIT)

    await onDefectReported(
      {
        defect_id: defectId,
        task_id: taskId,
        ac_id: acId,
        ac_text: 'Limit AC',
        severity: 'high',
        reproduction_steps: 'Steps...',
        reported_by: 'user:test',
        reported_at: new Date().toISOString(),
      },
      db,
      eventStore,
    )

    // Task state must NOT have changed to 'ready'
    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .limit(1)

    expect(taskRow!.state).toBe('in_review') // unchanged
    expect(taskRow!.iterationCount).toBe(ITERATION_LIMIT) // NOT incremented

    // DefectIterationLimitReached event must be present
    const limitEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'DefectIterationLimitReached'))

    const limitEvent = limitEvents.find(
      (e) => (e.payload as Record<string, unknown>)['task_id'] === taskId,
    )
    expect(limitEvent).toBeDefined()
    expect((limitEvent!.payload as Record<string, unknown>)['limit']).toBe(ITERATION_LIMIT)

    // TaskReopenedForDefect must NOT have been emitted for this task
    const reopenEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'TaskReopenedForDefect'))

    const noReopenEvent = reopenEvents.find(
      (e) => (e.payload as Record<string, unknown>)['task_id'] === taskId,
    )
    expect(noReopenEvent).toBeUndefined()
  })
})
