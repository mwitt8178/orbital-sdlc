/**
 * iteration-loop.integration.test.ts
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Acceptance criterion #2:
 *   - Submit a defect via DefectService.submitDefect
 *   - Assert task state transitions to 'ready', iteration_count=1
 *   - Assert TaskReopenedForDefect event emitted
 *
 * Real Postgres. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultDefectService } from '../../../src/uat/defects.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { onDefectReported } from '../../../src/hooks/post-defect-reported.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { defects as defectsTable } from '../../../src/db/schema/uat.js'
import { epics, stories, storyAcceptanceCriteria, sprints } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

let defectService: DefaultDefectService
let backlogService: DefaultBacklogService

const cleanup = {
  taskIds: [] as string[],
  storyIds: [] as string[],
  epicIds: [] as string[],
  sprintIds: [] as string[],
  defectIds: [] as string[],
}

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  backlogService = new DefaultBacklogService(db, eventStore)
  defectService = new DefaultDefectService(db, eventStore, backlogService)
})

afterAll(async () => {
  if (cleanup.defectIds.length > 0) {
    await db.delete(defectsTable).where(inArray(defectsTable.defectId, cleanup.defectIds)).catch(() => undefined)
  }
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedTask(): Promise<{ taskId: string; storyId: string; epicId: string; sprintId: string }> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const sprintId = uuidv7()
  const taskId = uuidv7()
  const acId = uuidv7()

  const now = new Date()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'Test epic (iteration-loop)',
    rationale: 'test',
    priority: 1000,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  await db.insert(stories).values({
    storyId,
    epicId,
    title: 'Test story (iteration-loop)',
    description: 'desc',
    status: 'in_review',
    priority: 1,
    storyPoints: 3,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  await db.insert(storyAcceptanceCriteria).values({
    acId,
    storyId,
    text: 'Test AC',
    ordinal: 1,
    schemaVersion: 1,
    createdAt: now,
  })

  await db.insert(sprints).values({
    sprintId,
    name: 'Test sprint',
    sequence: 9001,
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
    title: 'Test task',
    description: 'Task description',
    acceptanceCriteria: [],
    personaId: 'engineer',
    riskClass: 'standard',
    state: 'in_review',
    attemptCount: 0,
    retryBudget: 3,
    wallClockTimeoutMs: 300_000,
    tokenBudget: 50_000,
    linkedArtifacts: [],
    declaredWritePaths: [],
    createdAt: now,
    createdByEventId,
    iterationCount: 0,
    schemaVersion: 1,
  })

  cleanup.taskIds.push(taskId)
  cleanup.storyIds.push(storyId)
  cleanup.epicIds.push(epicId)
  cleanup.sprintIds.push(sprintId)

  return { taskId, storyId, epicId, sprintId }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('iteration-loop: submit defect → task reopens', () => {
  it('submitDefect emits DefectReported and onDefectReported transitions task to ready with iteration_count=1', async () => {
    const eventStore = createEventStore(db, sql)
    const { taskId, storyId } = await seedTask()
    const acId = uuidv7()

    // 1. Submit a defect
    const result = await defectService.submitDefect({
      taskId,
      acId,
      acText: 'AC must do X',
      reproductionSteps: '1. Click Y\n2. Observe Z',
      severity: 'medium',
      reportedBy: 'user:test',
    })
    cleanup.defectIds.push(result.defectId)

    expect(result.defectId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.defectKey).toMatch(/^DEF-/)

    // 2. Verify DefectReported event was emitted
    const defectEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'DefectReported'))

    const matchingEvent = defectEvents.find(
      (e) => (e.payload as Record<string, unknown>)['defect_id'] === result.defectId,
    )
    expect(matchingEvent).toBeDefined()
    expect((matchingEvent!.payload as Record<string, unknown>)['task_id']).toBe(taskId)

    // 3. Invoke onDefectReported directly (simulates the hook firing)
    await onDefectReported(
      {
        defect_id: result.defectId,
        task_id: taskId,
        ac_id: acId,
        ac_text: 'AC must do X',
        severity: 'medium',
        reproduction_steps: '1. Click Y\n2. Observe Z',
        reported_by: 'user:test',
        reported_at: new Date().toISOString(),
      },
      db,
      eventStore,
    )

    // 4. Verify task is now ready with iteration_count=1
    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .limit(1)

    expect(taskRow).toBeDefined()
    expect(taskRow!.state).toBe('ready')
    expect(taskRow!.iterationCount).toBe(1)
    expect(taskRow!.lastDefectId).toBe(result.defectId)
    expect(taskRow!.description).toContain('## Iteration 1: defect feedback')

    // 5. Verify TaskReopenedForDefect event
    const reopenEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'TaskReopenedForDefect'))

    const reopenEvent = reopenEvents.find(
      (e) => (e.payload as Record<string, unknown>)['task_id'] === taskId,
    )
    expect(reopenEvent).toBeDefined()
    expect((reopenEvent!.payload as Record<string, unknown>)['iteration_count']).toBe(1)
  })
})
