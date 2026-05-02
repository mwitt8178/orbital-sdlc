/**
 * Unit tests for PersonaOfRecord resolution.
 *
 * Per TRD-11 v0.2 §11.2.
 *
 * Tests the four-level precedence algorithm:
 * 1. AC-scoped implementation link wins
 * 2. Story-scoped (unique) implementation link
 * 3. Most-recent implementation task persona_id
 * 4. Fallback sentinel + PersonaOfRecordUnresolvable event
 *
 * Uses real Postgres per project conventions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import {
  DefaultPersonaOfRecord,
  PERSONA_OF_RECORD_UNKNOWN,
} from '../../../src/uat/persona-of-record.js'
import { personaOfRecordLinks, uatSessions } from '../../../src/db/schema/uat.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { events } from '../../../src/db/schema/events.js'
import { epics, stories, sprints } from '../../../src/db/schema/backlog.js'

let por: DefaultPersonaOfRecord

const ownedStoryIds: string[] = []
const ownedEpicIds: string[] = []
const ownedTaskIds: string[] = []
const ownedPorLinkIds: string[] = []
const ownedSessionIds: string[] = []
const ownedSprintIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  por = new DefaultPersonaOfRecord(db, eventStore)
})

beforeEach(() => {
  // Reset tracking arrays between tests
})

afterAll(async () => {
  if (ownedPorLinkIds.length > 0) {
    await db
      .delete(personaOfRecordLinks)
      .where(inArray(personaOfRecordLinks.porLinkId, ownedPorLinkIds))
      .catch(() => undefined)
  }
  if (ownedTaskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.taskId, ownedTaskIds)).catch(() => undefined)
  }
  if (ownedSessionIds.length > 0) {
    await db
      .delete(uatSessions)
      .where(inArray(uatSessions.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
  }
  if (ownedStoryIds.length > 0) {
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds)).catch(() => undefined)
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds)).catch(() => undefined)
  }
  if (ownedSprintIds.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, ownedSprintIds)).catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeEpicAndStory(): Promise<{ epicId: string; storyId: string }> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const now = new Date()

  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'por-test-epic',
    rationale: 'r',
    priority: 999,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  ownedEpicIds.push(epicId)

  await db.insert(stories).values({
    storyId,
    epicId,
    title: 'por-test-story',
    description: 'desc',
    status: 'done',
    priority: 1,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
  ownedStoryIds.push(storyId)

  return { epicId, storyId }
}

async function makeSprint(): Promise<string> {
  const sprintId = uuidv7()
  await db.insert(sprints).values({
    sprintId,
    name: 'por-test-sprint',
    sequence: 999,
    status: 'active',
    storyPointCapacity: 10,
    budgetUsdCents: 10000,
    concurrencyShare: 100,
    priorityClass: 'standard',
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: 1,
  })
  ownedSprintIds.push(sprintId)
  return sprintId
}

async function makeTask(storyId: string, personaId: string, sprintId?: string): Promise<string> {
  const taskId = uuidv7()
  const sid = sprintId ?? (await makeSprint())
  await db.insert(tasks).values({
    taskId,
    sprintId: sid,
    ticketId: 'TICK-001',
    title: 'por-test-task',
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
    createdAt: new Date(),
    createdByEventId: uuidv7(),
    schemaVersion: 1,
  })
  ownedTaskIds.push(taskId)
  return taskId
}

async function makePORLink(params: {
  storyId: string
  acId?: string
  personaId: string
  role?: 'implementation' | 'verification' | 'review' | 'tests' | 'design' | 'architecture'
}): Promise<string> {
  const porLinkId = uuidv7()
  const taskId = uuidv7()
  // Insert a stub task for FK reference
  const sprintId = await makeSprint()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: 'TICK-001',
    title: 'por-link-task',
    description: 'desc',
    acceptanceCriteria: [],
    storyId: params.storyId,
    personaId: params.personaId,
    riskClass: 'standard',
    state: 'done',
    attemptCount: 1,
    retryBudget: 3,
    wallClockTimeoutMs: 300000,
    tokenBudget: 100000,
    linkedArtifacts: [],
    declaredWritePaths: [],
    createdAt: new Date(),
    createdByEventId: uuidv7(),
    schemaVersion: 1,
  })
  ownedTaskIds.push(taskId)

  await db.insert(personaOfRecordLinks).values({
    porLinkId,
    storyId: params.storyId,
    acId: params.acId ?? null,
    personaId: params.personaId,
    role: params.role ?? 'implementation',
    taskId,
    workerSessionId: uuidv7(),
    recordedAt: new Date(),
    schemaVersion: 1,
  })
  ownedPorLinkIds.push(porLinkId)
  return porLinkId
}

async function makeUATSession(ticketId: string): Promise<string> {
  const sessionId = uuidv7()
  await db.insert(uatSessions).values({
    uatSessionId: sessionId,
    ticketId,
    storyVersion: 1,
    sessionVersion: 1,
    state: 'started',
    triggeredByEventId: uuidv7(),
    buildRef: 'test',
    startedByUserId: 'user:test',
    startedAt: new Date(),
    totalAcCount: 1,
    passCount: 0,
    failCount: 0,
    assumptionsSnapshot: [],
    schemaVersion: 1,
  })
  ownedSessionIds.push(sessionId)
  return sessionId
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonaOfRecord — step 1: AC-scoped link wins', () => {
  it('AC-scoped implementation link is used when present', async () => {
    const { storyId } = await makeEpicAndStory()
    const sessionId = await makeUATSession(storyId)
    const acId = uuidv7()

    // AC-scoped link → should win
    await makePORLink({ storyId, acId, personaId: 'persona:sr-dev', role: 'implementation' })
    // Story-scoped link (should lose to AC-scoped)
    await makePORLink({ storyId, personaId: 'persona:jr-dev', role: 'implementation' })

    const resolved = await por.resolve({ acId, storyId, sessionId })
    expect(resolved).toBe('persona:sr-dev')
  })
})

describe('PersonaOfRecord — step 2: story-scoped unique implementation link', () => {
  it('uses story-scoped link when exactly one exists', async () => {
    const { storyId } = await makeEpicAndStory()
    const sessionId = await makeUATSession(storyId)
    const acId = uuidv7() // no AC-scoped link for this acId

    await makePORLink({ storyId, personaId: 'persona:architect', role: 'implementation' })

    const resolved = await por.resolve({ acId, storyId, sessionId })
    expect(resolved).toBe('persona:architect')
  })

  it('falls through to step 3 when multiple story-scoped impl links exist', async () => {
    const { storyId } = await makeEpicAndStory()
    const sessionId = await makeUATSession(storyId)
    const acId = uuidv7()
    const sprintId = await makeSprint()

    // Two story-scoped implementation links → ambiguous, falls to step 3
    await makePORLink({ storyId, personaId: 'persona:dev-a', role: 'implementation' })
    await makePORLink({ storyId, personaId: 'persona:dev-b', role: 'implementation' })

    // Add a task so step 3 resolves
    await makeTask(storyId, 'persona:dev-b', sprintId)

    const resolved = await por.resolve({ acId, storyId, sessionId })
    expect(resolved).toBe('persona:dev-b') // most recent task
  })
})

describe('PersonaOfRecord — step 3: most-recent task persona_id', () => {
  it('uses most recent task persona_id when no POR links', async () => {
    const { storyId } = await makeEpicAndStory()
    const sessionId = await makeUATSession(storyId)
    const acId = uuidv7()
    const sprintId = await makeSprint()

    await makeTask(storyId, 'persona:qa', sprintId)

    const resolved = await por.resolve({ acId, storyId, sessionId })
    expect(resolved).toBe('persona:qa')
  })
})

describe('PersonaOfRecord — step 4: fallback sentinel', () => {
  it('returns sentinel and emits PersonaOfRecordUnresolvable when nothing found', async () => {
    const { storyId } = await makeEpicAndStory()
    const sessionId = await makeUATSession(storyId)
    const acId = uuidv7()

    const resolved = await por.resolve({ acId, storyId, sessionId })
    expect(resolved).toBe(PERSONA_OF_RECORD_UNKNOWN)

    // Verify PersonaOfRecordUnresolvable event was emitted
    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, sessionId))
    const warn = eventRows.find((e) => e.eventType === 'PersonaOfRecordUnresolvable')
    expect(warn).toBeTruthy()
  })
})
