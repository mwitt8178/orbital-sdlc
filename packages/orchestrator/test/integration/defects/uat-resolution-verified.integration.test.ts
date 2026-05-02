/**
 * uat-resolution-verified.integration.test.ts
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT (followup run)
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration-followup]
 *
 * Requirement:
 *   When ALL ACs for a UAT session pass AND the parent task has
 *   iteration_count > 0 (at least one defect-driven iteration occurred),
 *   UATService must emit exactly ONE UATResolutionVerified event.
 *
 * Setup:
 *   - Seed a task with iterationCount=2 (two defect iterations already done)
 *   - Start a real UAT session
 *   - Mark all ACs pass
 *   - Submit via UATService.submit()
 *   - Assert exactly ONE UATResolutionVerified event exists for the task_id
 *
 * Real Postgres. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray, and } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultUATService } from '../../../src/uat/service.js'
import { DefaultDefectService } from '../../../src/uat/defects.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { DefaultPersonaOfRecord } from '../../../src/uat/persona-of-record.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { uatSessions, uatAcResults, defects as defectsTable } from '../../../src/db/schema/uat.js'
import { epics, stories, storyAcceptanceCriteria, sprints } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

let uatService: DefaultUATService

const cleanup = {
  taskIds: [] as string[],
  storyIds: [] as string[],
  epicIds: [] as string[],
  sprintIds: [] as string[],
  uatSessionIds: [] as string[],
  defectIds: [] as string[],
  eventIds: [] as string[],
}

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const backlogService = new DefaultBacklogService(db, eventStore)
  const defectService = new DefaultDefectService(db, eventStore, backlogService)
  const personaOfRecord = new DefaultPersonaOfRecord(db, eventStore, null)
  uatService = new DefaultUATService(db, eventStore, defectService, personaOfRecord)
})

afterAll(async () => {
  // Clean in reverse FK order
  if (cleanup.uatSessionIds.length > 0) {
    await db
      .delete(uatAcResults)
      .where(inArray(uatAcResults.uatSessionId, cleanup.uatSessionIds))
      .catch(() => undefined)
    await db
      .delete(uatSessions)
      .where(inArray(uatSessions.uatSessionId, cleanup.uatSessionIds))
      .catch(() => undefined)
  }
  if (cleanup.defectIds.length > 0) {
    await db
      .delete(defectsTable)
      .where(inArray(defectsTable.defectId, cleanup.defectIds))
      .catch(() => undefined)
  }
  if (cleanup.taskIds.length > 0) {
    await db
      .delete(tasks)
      .where(inArray(tasks.taskId, cleanup.taskIds))
      .catch(() => undefined)
  }
  if (cleanup.storyIds.length > 0) {
    await db
      .delete(storyAcceptanceCriteria)
      .where(inArray(storyAcceptanceCriteria.storyId, cleanup.storyIds))
      .catch(() => undefined)
    await db
      .delete(stories)
      .where(inArray(stories.storyId, cleanup.storyIds))
      .catch(() => undefined)
  }
  if (cleanup.epicIds.length > 0) {
    await db
      .delete(epics)
      .where(inArray(epics.epicId, cleanup.epicIds))
      .catch(() => undefined)
  }
  if (cleanup.sprintIds.length > 0) {
    await db
      .delete(sprints)
      .where(inArray(sprints.sprintId, cleanup.sprintIds))
      .catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedResult {
  taskId: string
  storyId: string
  epicId: string
  sprintId: string
  acId: string
}

async function seedTaskWithIterations(iterationCount: number): Promise<SeedResult> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const sprintId = uuidv7()
  const taskId = uuidv7()
  const acId = uuidv7()
  const now = new Date()

  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'Test epic (uat-resolution-verified)',
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
    title: 'Test story (uat-resolution-verified)',
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
    text: 'The feature must render correctly after N iterations',
    ordinal: 1,
    schemaVersion: 1,
    createdAt: now,
  })

  await db.insert(sprints).values({
    sprintId,
    name: 'Test sprint (uat-resolution-verified)',
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

  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: storyId,
    storyId,
    title: 'Test task with prior iterations',
    description: 'Task description with prior defect iterations',
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
    createdByEventId: uuidv7(),
    // This task has already been through N defect-driven iterations
    iterationCount,
  })

  cleanup.taskIds.push(taskId)
  cleanup.storyIds.push(storyId)
  cleanup.epicIds.push(epicId)
  cleanup.sprintIds.push(sprintId)

  return { taskId, storyId, epicId, sprintId, acId }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UATResolutionVerified emission', () => {
  it('emits exactly one UATResolutionVerified when all ACs pass on a task with iteration_count=2', async () => {
    const eventStore = createEventStore(db, sql)
    const { storyId, acId } = await seedTaskWithIterations(2)

    // 1. Start a UAT session (real flow)
    const { session, acResults } = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'sha-test-resolution',
        resume_existing: false,
      },
      { userId: 'user:test-operator' },
    )
    cleanup.uatSessionIds.push(session.uatSessionId)

    expect(session.uatSessionId).toBeTruthy()
    expect(acResults).toHaveLength(1)
    const acResult = acResults[0]!

    // 2. Mark the single AC as 'pass'
    await uatService.markAC(
      {
        uat_session_id: session.uatSessionId,
        ac_id: acResult.acId,
        status: 'pass',
        observed_behavior: 'Feature renders correctly after iterations',
        evidence_links: [],
      },
      'user:test-operator',
    )

    // 3. Submit the session (all ACs pass → outcome='accepted')
    const submitResult = await uatService.submit(
      { uat_session_id: session.uatSessionId },
      'user:test-operator',
    )

    expect(submitResult.outcome).toBe('accepted')
    expect(submitResult.fail_count).toBe(0)
    expect(submitResult.pass_count).toBe(1)

    // 4. Assert exactly ONE UATResolutionVerified event was written
    const resolutionEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'UATResolutionVerified'))

    // Filter to events for our specific session (another parallel test might emit one too)
    const matchingEvents = resolutionEvents.filter(
      (e) =>
        (e.payload as Record<string, unknown>)['uat_session_id'] === session.uatSessionId,
    )

    expect(matchingEvents).toHaveLength(1)

    const payload = matchingEvents[0]!.payload as Record<string, unknown>
    expect(payload['uat_session_id']).toBe(session.uatSessionId)
    expect(payload['ticket_id']).toBe(storyId)
    expect(payload['total_iterations']).toBe(2)
    expect(typeof payload['task_id']).toBe('string')
    expect(payload['finalized_at']).toBeTruthy()
    // total_defects_filed and total_defects_resolved are numbers (0 here — none inserted)
    expect(typeof payload['total_defects_filed']).toBe('number')
    expect(typeof payload['total_defects_resolved']).toBe('number')
  })

  it('does NOT emit UATResolutionVerified when iteration_count=0 (first-pass session, no defects)', async () => {
    const eventStore = createEventStore(db, sql)
    const { storyId, acId } = await seedTaskWithIterations(0)

    const { session, acResults } = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'sha-test-no-iteration',
        resume_existing: false,
      },
      { userId: 'user:test-operator-2' },
    )
    cleanup.uatSessionIds.push(session.uatSessionId)

    const acResult = acResults[0]!
    await uatService.markAC(
      {
        uat_session_id: session.uatSessionId,
        ac_id: acResult.acId,
        status: 'pass',
        observed_behavior: 'Feature works as expected',
        evidence_links: [],
      },
      'user:test-operator-2',
    )

    const submitResult = await uatService.submit(
      { uat_session_id: session.uatSessionId },
      'user:test-operator-2',
    )
    expect(submitResult.outcome).toBe('accepted')

    // Should NOT have emitted UATResolutionVerified for this session
    const resolutionEvents = await db
      .select()
      .from(events)
      .where(eq(events.eventType, 'UATResolutionVerified'))

    const matchingEvents = resolutionEvents.filter(
      (e) =>
        (e.payload as Record<string, unknown>)['uat_session_id'] === session.uatSessionId,
    )

    expect(matchingEvents).toHaveLength(0)
  })
})
