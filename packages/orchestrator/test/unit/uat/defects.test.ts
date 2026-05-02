/**
 * Unit tests for DefectService.
 *
 * Per TRD-11 v0.2 §11.1.
 *
 * Tests:
 * - assignSeverity rule engine: R1–R5, first-match-wins
 * - createDefect: new defect row created with correct fields
 * - createDefect idempotency: duplicate AC re-fail updates existing defect
 * - DefectCreated event emitted on new defect
 * - DefectReopened event emitted on update
 *
 * Uses real Postgres per project conventions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultDefectService } from '../../../src/uat/defects.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import {
  uatSessions,
  uatAcResults,
  defects as defectsTable,
  defectLineage,
} from '../../../src/db/schema/uat.js'
import { epics, stories, storyAcceptanceCriteria } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'
import type { CreateDefectParams } from '../../../src/uat/types.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let defectSvc: DefaultDefectService
let ownedSessionIds: string[] = []
let ownedEpicIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const backlogService = new DefaultBacklogService(db, eventStore)
  defectSvc = new DefaultDefectService(db, eventStore, backlogService)
})

beforeEach(() => {
  ownedSessionIds = []
  ownedEpicIds = []
})

afterAll(async () => {
  if (ownedSessionIds.length > 0) {
    // defect_lineage → defects → uat_ac_results → uat_sessions
    const defectRows = await db
      .select({ defectId: defectsTable.defectId })
      .from(defectsTable)
      .where(inArray(defectsTable.uatSessionId, ownedSessionIds))
    if (defectRows.length > 0) {
      const defectIds = defectRows.map((r) => r.defectId)
      await db.delete(defectLineage)
        .where(inArray(defectLineage.defectId, defectIds))
        .catch(() => undefined)
      await db.delete(defectsTable)
        .where(inArray(defectsTable.defectId, defectIds))
        .catch(() => undefined)
    }
    await db.delete(uatAcResults)
      .where(inArray(uatAcResults.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
    await db.delete(uatSessions)
      .where(inArray(uatSessions.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
  }
  if (ownedEpicIds.length > 0) {
    const sRows = await db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(inArray(stories.epicId, ownedEpicIds))
    if (sRows.length > 0) {
      await db.delete(storyAcceptanceCriteria)
        .where(inArray(storyAcceptanceCriteria.storyId, sRows.map((r) => r.storyId)))
        .catch(() => undefined)
      await db.delete(stories)
        .where(inArray(stories.epicId, ownedEpicIds))
        .catch(() => undefined)
    }
    await db.delete(epics)
      .where(inArray(epics.epicId, ownedEpicIds))
      .catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// Create a minimal UAT session for defect insertion FK requirement
async function makeSession(storyId: string): Promise<{ sessionId: string; acResultId: string; acId: string }> {
  const sessionId = uuidv7()
  const acResultId = uuidv7()
  const acId = uuidv7()
  const now = new Date()

  await db.insert(uatSessions).values({
    uatSessionId: sessionId,
    ticketId: storyId,
    storyVersion: 1,
    sessionVersion: 1,
    state: 'submitted',
    triggeredByEventId: uuidv7(),
    buildRef: 'test',
    startedByUserId: 'user:test',
    startedAt: now,
    totalAcCount: 1,
    passCount: 0,
    failCount: 1,
    assumptionsSnapshot: [],
    schemaVersion: 1,
  })
  ownedSessionIds.push(sessionId)

  await db.insert(uatAcResults).values({
    acResultId,
    uatSessionId: sessionId,
    acId,
    acOrdinal: 1,
    acTextSnapshot: 'the feature does X',
    status: 'fail',
    observedBehavior: 'it broke',
    evidenceLinks: [],
    markedAt: now,
    markedByUserId: 'user:test',
    schemaVersion: 1,
  })

  return { sessionId, acResultId, acId }
}

async function makeStoryId(): Promise<string> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const now = new Date()

  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'defect-test-epic',
    rationale: 'r',
    priority: 1000,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  ownedEpicIds.push(epicId)

  await db.insert(stories).values({
    storyId,
    epicId,
    title: 'defect-test-story',
    description: 'desc',
    status: 'done',
    priority: 1,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  return storyId
}

// ---------------------------------------------------------------------------
// assignSeverity rule engine
// ---------------------------------------------------------------------------

describe('DefectService — assignSeverity rule engine', () => {
  it('R1: critical keyword in AC text → critical', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'security check must pass on login',
      failedAcCountForStory: 1,
      totalAcCountForStory: 5,
      isInActiveSprint: false,
      isReopen: false,
    })
    expect(severity).toBe('critical')
  })

  it('R1: "data loss" keyword → critical', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'no data loss during migration',
      failedAcCountForStory: 1,
      totalAcCountForStory: 4,
      isInActiveSprint: true,
      isReopen: false,
    })
    expect(severity).toBe('critical')
  })

  it('R2: in active sprint AND fail >= 50% → high', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'the button works',
      failedAcCountForStory: 3,
      totalAcCountForStory: 4,
      isInActiveSprint: true,
      isReopen: false,
    })
    expect(severity).toBe('high')
  })

  it('R2 does NOT fire if not in active sprint', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'the button works',
      failedAcCountForStory: 3,
      totalAcCountForStory: 4,
      isInActiveSprint: false,
      isReopen: false,
    })
    expect(severity).toBe('medium') // falls through to R5
  })

  it('R3: reopen → high', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'the tooltip renders correctly',
      failedAcCountForStory: 1,
      totalAcCountForStory: 10,
      isInActiveSprint: false,
      isReopen: true,
    })
    expect(severity).toBe('high')
  })

  it('R4: performance AC and observed > 2× expected → high', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'p95 latency must be under 200ms',
      failedAcCountForStory: 1,
      totalAcCountForStory: 5,
      isInActiveSprint: false,
      isReopen: false,
      observedValue: 500,
      expectedValue: 200,
    })
    expect(severity).toBe('high')
  })

  it('R5: default → medium', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'the color is correct',
      failedAcCountForStory: 1,
      totalAcCountForStory: 5,
      isInActiveSprint: false,
      isReopen: false,
    })
    expect(severity).toBe('medium')
  })

  it('R1 takes precedence over R3 (first-match-wins)', () => {
    const severity = defectSvc.assignSeverity({
      acText: 'security token must not be logged (financial risk)',
      failedAcCountForStory: 1,
      totalAcCountForStory: 2,
      isInActiveSprint: true,
      isReopen: true,
    })
    // R1 fires first for 'security' keyword
    expect(severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// createDefect
// ---------------------------------------------------------------------------

describe('DefectService — createDefect', () => {
  it('creates a new defect row with correct fields', async () => {
    const storyId = await makeStoryId()
    const { sessionId, acResultId, acId } = await makeSession(storyId)

    const params: CreateDefectParams = {
      failedAcResultId: acResultId,
      sessionId,
      storyId,
      acId,
      acText: 'the feature does X',
      observedBehavior: 'it did Y instead',
      personaOfRecordId: 'persona:sr-dev',
      severity: 'medium',
      preemptsSprint: false,
    }

    const defect = await defectSvc.createDefect(params)

    expect(defect.defectId).toBeTruthy()
    expect(defect.originStoryId).toBe(storyId)
    expect(defect.originAcId).toBe(acId)
    expect(defect.uatSessionId).toBe(sessionId)
    expect(defect.personaOfRecordId).toBe('persona:sr-dev')
    expect(defect.severity).toBe('medium')
    expect(defect.state).toBe('open')
    expect(defect.observedBehavior).toBe('it did Y instead')
    expect(defect.expectedBehavior).toBe('the feature does X')
    expect(defect.reopenCount).toBe(0)
    expect(defect.fixingTicketId).toBeNull()

    // defect_lineage row also created
    const lineage = await db
      .select()
      .from(defectLineage)
      .where(eq(defectLineage.defectId, defect.defectId))
      .limit(1)
    expect(lineage).toHaveLength(1)
  })

  it('emits DefectCreated event', async () => {
    const storyId = await makeStoryId()
    const { sessionId, acResultId, acId } = await makeSession(storyId)

    const defect = await defectSvc.createDefect({
      failedAcResultId: acResultId,
      sessionId,
      storyId,
      acId,
      acText: 'AC text',
      observedBehavior: 'observed',
      personaOfRecordId: 'persona:qa',
      severity: 'low',
      preemptsSprint: false,
    })

    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, defect.defectId))

    const defectCreated = eventRows.find((e) => e.eventType === 'DefectCreated')
    expect(defectCreated).toBeTruthy()
    expect((defectCreated!.payload as any).defect_id).toBe(defect.defectId)
  })

  it('updates existing open defect on duplicate AC re-fail (idempotent)', async () => {
    const storyId = await makeStoryId()
    const { sessionId, acResultId, acId } = await makeSession(storyId)

    // First defect creation
    const first = await defectSvc.createDefect({
      failedAcResultId: acResultId,
      sessionId,
      storyId,
      acId,
      acText: 'AC text',
      observedBehavior: 'first observation',
      personaOfRecordId: 'persona:sr-dev',
      severity: 'medium',
      preemptsSprint: false,
    })

    expect(first.state).toBe('open')
    expect(first.reopenCount).toBe(0)

    // Create a second session for the same story/AC
    const sessionId2 = uuidv7()
    const acResultId2 = uuidv7()
    const now = new Date()
    await db.insert(uatSessions).values({
      uatSessionId: sessionId2,
      ticketId: storyId,
      storyVersion: 1,
      sessionVersion: 2,
      state: 'submitted',
      triggeredByEventId: uuidv7(),
      buildRef: 'test2',
      startedByUserId: 'user:test',
      startedAt: now,
      totalAcCount: 1,
      passCount: 0,
      failCount: 1,
      assumptionsSnapshot: [],
      schemaVersion: 1,
    })
    ownedSessionIds.push(sessionId2)
    await db.insert(uatAcResults).values({
      acResultId: acResultId2,
      uatSessionId: sessionId2,
      acId,
      acOrdinal: 1,
      acTextSnapshot: 'AC text',
      status: 'fail',
      observedBehavior: 'second observation',
      evidenceLinks: [],
      markedAt: now,
      markedByUserId: 'user:test',
      schemaVersion: 1,
    })

    // Re-fail the same AC — should update, not create new defect
    const updated = await defectSvc.createDefect({
      failedAcResultId: acResultId2,
      sessionId: sessionId2,
      storyId,
      acId,
      acText: 'AC text',
      observedBehavior: 'second observation',
      personaOfRecordId: 'persona:sr-dev',
      severity: 'medium',
      preemptsSprint: false,
    })

    expect(updated.defectId).toBe(first.defectId) // same defect
    expect(updated.state).toBe('reopened')
    expect(updated.reopenCount).toBe(1)

    // Verify DefectReopened event
    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, first.defectId))
    const reopened = eventRows.find((e) => e.eventType === 'DefectReopened')
    expect(reopened).toBeTruthy()
  })
})
