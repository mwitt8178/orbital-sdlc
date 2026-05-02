/**
 * Integration test: UAT full lifecycle.
 *
 * Per TRD-11 v0.2 §11.2 and task done criteria:
 * "start session, mark 3 ACs pass, mark 1 fail, submit, accept with partial
 *  → verify 1 defect in DB and 1 new story in backlog"
 *
 * Exercises:
 * - Session creation with AC snapshot
 * - Mark 3 pass, 1 fail
 * - Submit: produces 1 defect, 1 defect_lineage row, correct events emitted
 * - partialAccept: session moves to partially_accepted
 * - promoteToBacklog: 1 new backlog story with origin_story_id wired
 * - UATSessionStarted, UATACMarked, UATSubmitted, UATPartialAcceptance events present
 * - DefectCreated event present with correct payload
 *
 * Real Postgres. No mocks. All events via EventStore.append.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray, and } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultUATService } from '../../../src/uat/service.js'
import { DefaultDefectService } from '../../../src/uat/defects.js'
import { DefaultPersonaOfRecord } from '../../../src/uat/persona-of-record.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import {
  uatSessions,
  uatAcResults,
  defects as defectsTable,
  defectLineage,
  personaOfRecordLinks,
} from '../../../src/db/schema/uat.js'
import {
  epics,
  stories,
  storyAcceptanceCriteria,
  sprints,
} from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'
import { tasks } from '../../../src/db/schema/orchestration.js'

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

let uatService: DefaultUATService
let defectService: DefaultDefectService
let backlogService: DefaultBacklogService

// Track all created rows for cleanup
const cleanup = {
  sessionIds: [] as string[],
  epicIds: [] as string[],
  storyIds: [] as string[],
  taskIds: [] as string[],
  sprintIds: [] as string[],
  porLinkIds: [] as string[],
}

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  backlogService = new DefaultBacklogService(db, eventStore)
  defectService = new DefaultDefectService(db, eventStore, backlogService)
  const por = new DefaultPersonaOfRecord(db, eventStore)
  uatService = new DefaultUATService(db, eventStore, defectService, por)
})

afterAll(async () => {
  // Clean up in FK order: lineage → defects → ac_results → sessions → story_acs → stories → epics
  if (cleanup.sessionIds.length > 0) {
    const defectRows = await db
      .select({ defectId: defectsTable.defectId })
      .from(defectsTable)
      .where(inArray(defectsTable.uatSessionId, cleanup.sessionIds))
    if (defectRows.length > 0) {
      const dIds = defectRows.map((r) => r.defectId)
      await db.delete(defectLineage).where(inArray(defectLineage.defectId, dIds)).catch(() => undefined)
      await db.delete(defectsTable).where(inArray(defectsTable.defectId, dIds)).catch(() => undefined)
    }
    await db.delete(uatAcResults).where(inArray(uatAcResults.uatSessionId, cleanup.sessionIds)).catch(() => undefined)
    await db.delete(uatSessions).where(inArray(uatSessions.uatSessionId, cleanup.sessionIds)).catch(() => undefined)
  }
  if (cleanup.porLinkIds.length > 0) {
    await db.delete(personaOfRecordLinks).where(inArray(personaOfRecordLinks.porLinkId, cleanup.porLinkIds)).catch(() => undefined)
  }
  if (cleanup.taskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.taskId, cleanup.taskIds)).catch(() => undefined)
  }
  // Clean up fix stories (those with origin_story_id set from defect promotion)
  if (cleanup.storyIds.length > 0) {
    // Get all stories that reference our origin stories
    const allRelated = await db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(inArray(stories.originStoryId, cleanup.storyIds))
    const allIds = [...cleanup.storyIds, ...allRelated.map((r) => r.storyId)]
    await db.delete(storyAcceptanceCriteria).where(inArray(storyAcceptanceCriteria.storyId, allIds)).catch(() => undefined)
    await db.delete(stories).where(inArray(stories.storyId, allIds)).catch(() => undefined)
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

async function seedStoryWith4ACs(): Promise<{
  epicId: string
  storyId: string
  acIds: string[]
}> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const now = new Date()

  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'integration-test-epic',
    rationale: 'rationale',
    priority: 9999,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  cleanup.epicIds.push(epicId)

  await db.insert(stories).values({
    storyId,
    epicId,
    title: 'integration-test-story',
    description: 'desc',
    status: 'done',
    priority: 1,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  cleanup.storyIds.push(storyId)

  const acIds: string[] = []
  for (let i = 0; i < 4; i++) {
    const acId = uuidv7()
    acIds.push(acId)
    await db.insert(storyAcceptanceCriteria).values({
      acId,
      storyId,
      ordinal: i + 1,
      text: i === 3
        ? 'The login form must not leak credentials (security requirement)'
        : `AC-${i + 1}: the feature does thing ${i + 1}`,
      createdAt: now,
      schemaVersion: 1,
    })
  }

  return { epicId, storyId, acIds }
}

async function seedPersonaLink(storyId: string, personaId: string): Promise<void> {
  const sprintId = uuidv7()
  const taskId = uuidv7()
  const porLinkId = uuidv7()
  const now = new Date()

  await db.insert(sprints).values({
    sprintId,
    name: 'integration-sprint',
    sequence: 9999,
    status: 'active',
    storyPointCapacity: 10,
    budgetUsdCents: 10000,
    concurrencyShare: 100,
    priorityClass: 'standard',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  cleanup.sprintIds.push(sprintId)

  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: 'INT-001',
    title: 'integration-task',
    description: 'desc',
    acceptanceCriteria: [],
    storyId,
    personaId,
    riskClass: 'standard',
    state: 'done',
    attemptCount: 1,
    retryBudget: 3,
    wallClockTimeoutMs: 300000,
    tokenBudget: 100000,
    linkedArtifacts: [],
    declaredWritePaths: [],
    createdAt: now,
    createdByEventId: uuidv7(),
    schemaVersion: 1,
  })
  cleanup.taskIds.push(taskId)

  await db.insert(personaOfRecordLinks).values({
    porLinkId,
    storyId,
    personaId,
    role: 'implementation',
    taskId,
    workerSessionId: uuidv7(),
    recordedAt: now,
    schemaVersion: 1,
  })
  cleanup.porLinkIds.push(porLinkId)
}

// ---------------------------------------------------------------------------
// Full lifecycle test
// ---------------------------------------------------------------------------

describe('UAT lifecycle integration', () => {
  it('full flow: start session → mark 3 pass + 1 fail → submit → partial-accept → 1 defect + 1 backlog story', async () => {
    const { epicId, storyId, acIds } = await seedStoryWith4ACs()
    const PERSONA_ID = 'persona:sr-dev'

    // Seed persona-of-record link so step 2 of the algorithm resolves correctly
    await seedPersonaLink(storyId, PERSONA_ID)

    // -----------------------------------------------------------------------
    // 1. Start session
    // -----------------------------------------------------------------------
    const startResult = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'abc123',
        resume_existing: false,
        justification: 'starting UAT for integration test',
      },
      { userId: 'user:tester', installId: 'install:local' },
    )

    const sessionId = startResult.session.uatSessionId
    cleanup.sessionIds.push(sessionId)

    expect(startResult.session.state).toBe('started')
    expect(startResult.session.totalAcCount).toBe(4)
    expect(startResult.acResults).toHaveLength(4)
    expect(startResult.acResults.every((r) => r.status === 'pending')).toBe(true)

    // Verify UATSessionStarted event
    const startEvent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.aggregateId, sessionId),
          eq(events.eventType, 'UATSessionStarted'),
        ),
      )
    expect(startEvent).toHaveLength(1)

    // -----------------------------------------------------------------------
    // 2. Mark 3 ACs pass
    // -----------------------------------------------------------------------
    for (const acId of acIds.slice(0, 3)) {
      const markResult = await uatService.markAC(
        { uat_session_id: sessionId, ac_id: acId, status: 'pass', justification: 'looks good' },
        'user:tester',
      )
      expect(markResult.status).toBe('pass')
    }

    // -----------------------------------------------------------------------
    // 3. Mark 1 AC fail (AC-4 has security text → will be severity=critical)
    // -----------------------------------------------------------------------
    const failResult = await uatService.markAC(
      {
        uat_session_id: sessionId,
        ac_id: acIds[3]!,
        status: 'fail',
        observed_behavior: 'credentials visible in network tab',
        justification: 'security regression detected',
      },
      'user:tester',
    )
    expect(failResult.status).toBe('fail')
    expect(failResult.fail_count).toBe(1)
    expect(failResult.pass_count).toBe(3)

    // Verify session is in_progress
    const [sessionAfterMarks] = await db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)
    expect(sessionAfterMarks?.state).toBe('in_progress')
    expect(sessionAfterMarks?.passCount).toBe(3)
    expect(sessionAfterMarks?.failCount).toBe(1)

    // -----------------------------------------------------------------------
    // 4. Submit
    // -----------------------------------------------------------------------
    const submitResult = await uatService.submit(
      {
        uat_session_id: sessionId,
        outcome_notes: 'partial pass — security AC failed',
        justification: 'submitting UAT results',
      },
      'user:tester',
    )

    expect(submitResult.outcome).toBe('partially_accepted')
    expect(submitResult.pass_count).toBe(3)
    expect(submitResult.fail_count).toBe(1)
    expect(submitResult.defects_created).toHaveLength(1)

    const defectSummary = submitResult.defects_created[0]!
    expect(defectSummary.severity).toBe('critical') // R1: security keyword in AC text
    expect(defectSummary.origin_ac_id).toBe(acIds[3])

    // -----------------------------------------------------------------------
    // 5. Verify exactly 1 defect row in DB
    // -----------------------------------------------------------------------
    const defectRows = await db
      .select()
      .from(defectsTable)
      .where(eq(defectsTable.uatSessionId, sessionId))

    expect(defectRows).toHaveLength(1)
    const defect = defectRows[0]!

    expect(defect.originStoryId).toBe(storyId)
    expect(defect.originAcId).toBe(acIds[3])
    expect(defect.personaOfRecordId).toBe(PERSONA_ID)
    expect(defect.severity).toBe('critical')
    expect(defect.state).toBe('open')
    expect(defect.fixingTicketId).toBeNull() // populated by TRD-02, not by 5A

    // Verify defect_lineage row created
    const lineageRows = await db
      .select()
      .from(defectLineage)
      .where(eq(defectLineage.defectId, defect.defectId))
    expect(lineageRows).toHaveLength(1)

    // -----------------------------------------------------------------------
    // 6. Verify required events emitted
    // -----------------------------------------------------------------------
    const allSessionEvents = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sessionId))

    const eventTypes = allSessionEvents.map((e) => e.eventType)
    expect(eventTypes).toContain('UATSessionStarted')
    expect(eventTypes).toContain('UATACMarked')
    expect(eventTypes).toContain('UATSubmitted')
    // UATPartialAcceptance is emitted by submit when partially_accepted
    expect(eventTypes).toContain('UATPartialAcceptance')

    const defectCreatedEvent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.aggregateId, defect.defectId),
          eq(events.eventType, 'DefectCreated'),
        ),
      )
    expect(defectCreatedEvent).toHaveLength(1)
    const dcPayload = defectCreatedEvent[0]!.payload as any
    expect(dcPayload.persona_of_record_id).toBe(PERSONA_ID)
    expect(dcPayload.severity).toBe('critical')
    expect(dcPayload.preempts_sprint).toBe(true)

    // -----------------------------------------------------------------------
    // 7. Promote defect to backlog (creates 1 new story)
    // -----------------------------------------------------------------------
    const { storyId: fixStoryId } = await defectService.promoteToBacklog(
      defect.defectId,
      epicId,
    )

    cleanup.storyIds.push(fixStoryId)

    const [fixStory] = await db
      .select()
      .from(stories)
      .where(eq(stories.storyId, fixStoryId))
      .limit(1)

    expect(fixStory).toBeTruthy()
    expect(fixStory!.originStoryId).toBe(storyId)
    expect(fixStory!.defectId).toBe(defect.defectId)
    expect(fixStory!.personaOfRecord).toBe(PERSONA_ID)

    // Verify StoryCreated event emitted for the fix story
    const storyCreatedEvent = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.aggregateId, fixStoryId),
          eq(events.eventType, 'StoryCreated'),
        ),
      )
    expect(storyCreatedEvent).toHaveLength(1)

    // -----------------------------------------------------------------------
    // 8. Session is in partially_accepted state
    // -----------------------------------------------------------------------
    const [finalSession] = await db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)

    expect(finalSession?.state).toBe('partially_accepted')
  })

  it('idempotent submit: calling submit twice on same session returns same result', async () => {
    const { storyId } = await seedStoryWith4ACs()
    const { session, acResults } = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'test',
        resume_existing: false,
        justification: 'test',
      },
      { userId: 'user:tester' },
    )
    cleanup.sessionIds.push(session.uatSessionId)

    // Mark all pass
    for (const acResult of acResults) {
      await uatService.markAC(
        { uat_session_id: session.uatSessionId, ac_id: acResult.acId, status: 'pass', justification: 'test' },
        'user:tester',
      )
    }

    const result1 = await uatService.submit(
      { uat_session_id: session.uatSessionId, justification: 'test' },
      'user:tester',
    )
    const result2 = await uatService.submit(
      { uat_session_id: session.uatSessionId, justification: 'test-idempotent' },
      'user:tester',
    )

    expect(result1.outcome).toBe(result2.outcome)
    expect(result1.defects_created.length).toBe(result2.defects_created.length)
  })

  it('listSessions returns all sessions for a ticket in order', async () => {
    const { storyId } = await seedStoryWith4ACs()

    // Session 1
    const { session: s1, acResults: ac1 } = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'v1',
        resume_existing: false,
        justification: 'test',
      },
      { userId: 'user:tester' },
    )
    cleanup.sessionIds.push(s1.uatSessionId)

    // Mark all pass for s1 and submit
    for (const r of ac1) {
      await uatService.markAC(
        { uat_session_id: s1.uatSessionId, ac_id: r.acId, status: 'pass', justification: 'test' },
        'user:tester',
      )
    }
    await uatService.submit({ uat_session_id: s1.uatSessionId, justification: 'test' }, 'user:tester')

    // Session 2
    const { session: s2 } = await uatService.startSession(
      {
        ticket_id: storyId,
        triggered_by_event_id: uuidv7(),
        build_ref: 'v2',
        resume_existing: false,
        justification: 'test',
      },
      { userId: 'user:tester' },
    )
    cleanup.sessionIds.push(s2.uatSessionId)

    const list = await uatService.listSessions(storyId)
    expect(list).toHaveLength(2)
    expect(list[0]!.session.sessionVersion).toBe(1)
    expect(list[1]!.session.sessionVersion).toBe(2)
  })
})
