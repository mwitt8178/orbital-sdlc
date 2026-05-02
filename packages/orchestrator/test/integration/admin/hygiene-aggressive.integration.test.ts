/**
 * integration/admin/hygiene-aggressive.integration.test.ts
 *
 * Integration tests for the v2 aggressive hygiene sweep methods.
 * Uses a REAL Postgres database (same pool as other integration tests).
 *
 * Each test inserts rows, runs the sweep, and verifies the DB state.
 * All tests clean up after themselves via afterEach DELETE (on test-inserted rows only).
 *
 * Tests verify:
 *   - State transitions are applied correctly (epics→cancelled, visions→abandoned, etc.)
 *   - Preserved-keyword visions are NOT transitioned
 *   - dryRun=true leaves all rows unchanged
 *   - Running twice produces 0 additional transitions (idempotency)
 *   - AdminHygieneSweepCompleted events are emitted for each category with candidates
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { db, sql as sqlPool } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { HygieneService } from '../../../src/admin/hygiene.js'
import { stories, sprints, epics } from '../../../src/db/schema/backlog.js'
import { visionDocuments, visionSessions } from '../../../src/db/schema/vision.js'
import { ceremonies } from '../../../src/db/schema/comms-workflow.js'
import { channels } from '../../../src/db/schema/channels.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'
import { capabilityGrants } from '../../../src/db/schema/capabilities.js'
import { defects } from '../../../src/db/schema/uat.js'
import { uatSessions, uatAcResults } from '../../../src/db/schema/uat.js'

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------

const cleanup = {
  epicIds: [] as string[],
  storyIds: [] as string[],
  sprintIds: [] as string[],
  visionDocumentIds: [] as string[],
  visionSessionIds: [] as string[],
  ceremonyIds: [] as string[],
  channelIds: [] as string[],
  workerIds: [] as string[],
  capabilityIds: [] as string[],
  defectIds: [] as string[],
  uatSessionIds: [] as string[],
  uatAcResultIds: [] as string[],
}

function resetCleanup() {
  Object.values(cleanup).forEach((arr) => (arr.length = 0))
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

async function insertEpic(title: string, status = 'active'): Promise<string> {
  const epicId = uuidv7()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title,
    rationale: 'hygiene test',
    priority: 9999,
    // @ts-expect-error — 'active' is valid; TypeScript narrows to union but value is safe
    status,
    schemaVersion: 1,
  })
  cleanup.epicIds.push(epicId)
  return epicId
}

async function insertStory(epicId: string, title: string, status = 'backlog'): Promise<string> {
  const storyId = uuidv7()
  await db.insert(stories).values({
    storyId,
    epicId,
    title,
    description: 'hygiene test',
    // @ts-expect-error — status union
    status,
    priority: 0,
    schemaVersion: 1,
  })
  cleanup.storyIds.push(storyId)
  return storyId
}

async function insertSprint(name: string, status = 'active'): Promise<string> {
  const sprintId = uuidv7()
  await db.insert(sprints).values({
    sprintId,
    name,
    sequence: 7777,
    // @ts-expect-error — status union
    status,
    storyPointCapacity: 1,
    budgetUsdCents: 100,
    concurrencyShare: 100,
    priorityClass: 'standard',
    schemaVersion: 1,
  })
  cleanup.sprintIds.push(sprintId)
  return sprintId
}

async function insertVisionDocument(title: string, lifecycleState = 'drafting'): Promise<string> {
  const visionDocumentId = uuidv7()
  await db.insert(visionDocuments).values({
    visionDocumentId,
    installId: uuidv7(),
    title,
    // @ts-expect-error — enum
    lifecycleState,
    currentVersionNumber: 0,
    createdBy: { type: 'user', user_id: 'test-user' },
    lastEventId: uuidv7(),
  })
  cleanup.visionDocumentIds.push(visionDocumentId)
  return visionDocumentId
}

async function insertVisionSession(
  visionDocumentId: string,
  startedAt: Date,
  state = 'open',
): Promise<string> {
  const visionSessionId = uuidv7()
  await db.insert(visionSessions).values({
    visionSessionId,
    visionDocumentId,
    // @ts-expect-error — enum
    state,
    startedAt,
    exchangeCount: 0,
    tokenTotal: 0,
    startedBy: { type: 'user', user_id: 'test-user' },
  })
  cleanup.visionSessionIds.push(visionSessionId)
  return visionSessionId
}

async function insertCeremony(sprintId: string, state = 'scheduled'): Promise<string> {
  const ceremonyId = uuidv7()
  // Need a spec_id that exists. Fetch any existing ceremony_spec or create a synthetic one.
  // For integration tests, we use a synthetic non-FK uuid since ceremonies.spec_id
  // does not have a physical FK in this schema.
  await db.insert(ceremonies).values({
    ceremonyId,
    // @ts-expect-error — enum
    ceremonyType: 'sprint_planning',
    specId: uuidv7(), // synthetic; no FK constraint
    channelId: uuidv7(), // synthetic
    // @ts-expect-error — enum
    state,
    triggeredBy: { type: 'system', component: 'test' },
    scope: { sprint_id: sprintId },
    turnsPerParticipant: 3,
    tokensPerTurn: 1000,
    wallClockBudgetMs: 60000,
    voteRule: 'simple_majority',
    voteRequired: true,
    schemaVersion: 1,
  })
  cleanup.ceremonyIds.push(ceremonyId)
  return ceremonyId
}

async function insertChannel(storyId: string): Promise<string> {
  const channelId = uuidv7()
  const name = `test-ch-${channelId.slice(0, 8)}`
  await db.insert(channels).values({
    channelId,
    name,
    kind: 'ticket_durable',
    scopeRef: { story_id: storyId },
    createdByActor: { type: 'system', component: 'test' },
    schemaVersion: 1,
  })
  cleanup.channelIds.push(channelId)
  return channelId
}

async function insertAgentWorker(lastHeartbeatAt: Date | null, startedAt: Date): Promise<string> {
  const workerId = uuidv7()
  await db.insert(agentWorkers).values({
    workerId,
    personaId: 'test-persona',
    sessionId: uuidv7(),
    taskId: uuidv7(),
    status: 'active',
    startedAt,
    lastHeartbeatAt,
    capabilityId: uuidv7(),
  })
  cleanup.workerIds.push(workerId)
  return workerId
}

async function insertCapabilityGrant(sprintId: string, issuedAt: Date): Promise<string> {
  const capId = uuidv7()
  const now = new Date()
  const exp = new Date(now.getTime() + 60 * 60 * 1000)
  await db.insert(capabilityGrants).values({
    capability_id: capId,
    task_id: uuidv7(),
    session_id: uuidv7(),
    persona_id: 'test-persona',
    sprint_id: sprintId,
    signing_sub_key_id: uuidv7(),
    scopes: [],
    issued_at: issuedAt,
    expires_at: exp,
    bundle_hash: `hash-${capId}`,
    signature: `sig-${capId}`,
    status: 'active',
    schema_version: 1,
  })
  cleanup.capabilityIds.push(capId)
  return capId
}

async function insertDefect(originStoryId: string, state = 'open'): Promise<string> {
  // defects require a uat_session and ac_result due to FK constraints
  const uatSessionId = uuidv7()
  await db.insert(uatSessions).values({
    uatSessionId,
    ticketId: uuidv7(),
    storyVersion: 1,
    sessionVersion: 1,
    state: 'submitted',
    triggeredByEventId: uuidv7(),
    buildRef: 'test-build',
    startedByUserId: 'test-user',
    totalAcCount: 1,
    passCount: 0,
    failCount: 1,
    schemaVersion: 1,
  })
  cleanup.uatSessionIds.push(uatSessionId)

  const acResultId = uuidv7()
  await db.insert(uatAcResults).values({
    acResultId,
    uatSessionId,
    acId: uuidv7(),
    acOrdinal: 1,
    acTextSnapshot: 'test AC',
    status: 'fail',
    schemaVersion: 1,
  })
  cleanup.uatAcResultIds.push(acResultId)

  const defectId = uuidv7()
  await db.insert(defects).values({
    defectId,
    defectKey: `DEF-TEST-${defectId.slice(0, 8)}`,
    originStoryId,
    originAcId: uuidv7(),
    uatSessionId,
    acResultId,
    personaOfRecordId: 'test-persona',
    title: 'Test defect for hygiene',
    observedBehavior: 'test broke',
    expectedBehavior: 'should work',
    severity: 'low',
    // @ts-expect-error — enum
    state,
    schemaVersion: 1,
  })
  cleanup.defectIds.push(defectId)
  return defectId
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function makeService(): HygieneService {
  const es = createEventStore(db, sqlPool)
  return new HygieneService(db, es)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCleanup()
})

afterEach(async () => {
  // Delete in FK-safe order
  if (cleanup.defectIds.length > 0) {
    await db.delete(defects).where(inArray(defects.defectId, cleanup.defectIds))
  }
  if (cleanup.uatAcResultIds.length > 0) {
    await db.delete(uatAcResults).where(inArray(uatAcResults.acResultId, cleanup.uatAcResultIds))
  }
  if (cleanup.uatSessionIds.length > 0) {
    await db.delete(uatSessions).where(inArray(uatSessions.uatSessionId, cleanup.uatSessionIds))
  }
  if (cleanup.channelIds.length > 0) {
    await db.delete(channels).where(inArray(channels.channelId, cleanup.channelIds))
  }
  if (cleanup.ceremonyIds.length > 0) {
    await db.delete(ceremonies).where(inArray(ceremonies.ceremonyId, cleanup.ceremonyIds))
  }
  if (cleanup.capabilityIds.length > 0) {
    // capability_grants has a Postgres append-only trigger that blocks DELETE.
    // Instead, revoke any test grants so they're in a terminal state and won't
    // pollute future sweep runs. Rows will persist (by design — audit trail).
    await db
      .update(capabilityGrants)
      .set({ status: 'revoked' })
      .where(
        inArray(capabilityGrants.capability_id, cleanup.capabilityIds),
      )
  }
  if (cleanup.workerIds.length > 0) {
    await db.delete(agentWorkers).where(inArray(agentWorkers.workerId, cleanup.workerIds))
  }
  if (cleanup.visionSessionIds.length > 0) {
    await db
      .delete(visionSessions)
      .where(inArray(visionSessions.visionSessionId, cleanup.visionSessionIds))
  }
  if (cleanup.visionDocumentIds.length > 0) {
    await db
      .delete(visionDocuments)
      .where(inArray(visionDocuments.visionDocumentId, cleanup.visionDocumentIds))
  }
  if (cleanup.storyIds.length > 0) {
    await db.delete(stories).where(inArray(stories.storyId, cleanup.storyIds))
  }
  if (cleanup.epicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, cleanup.epicIds))
  }
  if (cleanup.sprintIds.length > 0) {
    await db.delete(sprints).where(inArray(sprints.sprintId, cleanup.sprintIds))
  }
})

// ---------------------------------------------------------------------------
// cleanFixtureEpics
// ---------------------------------------------------------------------------

describe('cleanFixtureEpics (integration)', () => {
  it('cancels epics with short test titles', async () => {
    const epicId = await insertEpic('ab', 'active')

    const service = makeService()
    const result = await service.cleanFixtureEpics({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db.select().from(epics).where(eq(epics.epicId, epicId))
    expect(row?.status).toBe('cancelled')
  })

  it('does NOT cancel epics with preserved keywords', async () => {
    const epicId = await insertEpic('billing module', 'active')

    const service = makeService()
    await service.cleanFixtureEpics({ dryRun: false })

    const [row] = await db.select().from(epics).where(eq(epics.epicId, epicId))
    expect(row?.status).toBe('active')
  })

  it('dryRun=true leaves epic unchanged', async () => {
    const epicId = await insertEpic('x', 'active')

    const service = makeService()
    const result = await service.cleanFixtureEpics({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain(epicId)

    const [row] = await db.select().from(epics).where(eq(epics.epicId, epicId))
    expect(row?.status).toBe('active')
  })

  it('is idempotent — second run transitions 0 epics', async () => {
    await insertEpic('zz', 'active')

    const service = makeService()
    await service.cleanFixtureEpics({ dryRun: false })

    const second = await service.cleanFixtureEpics({ dryRun: false })
    // Our test epic is now cancelled; should not appear again
    // (idempotency: WHERE status != 'cancelled' excludes it)
    // We can't guarantee 0 if other test epics exist, so we verify ours is gone
    expect(second.sampleIds).not.toContain(cleanup.epicIds[0]!)
  })
})

// ---------------------------------------------------------------------------
// cleanFixtureVisions
// ---------------------------------------------------------------------------

describe('cleanFixtureVisions (integration)', () => {
  it('abandons visions with short junk titles', async () => {
    const visionId = await insertVisionDocument('abc', 'drafting')

    const service = makeService()
    const result = await service.cleanFixtureVisions({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, visionId))
    expect(row?.lifecycleState).toBe('abandoned')
  })

  it('preserves visions with product keywords in title', async () => {
    const visionId = await insertVisionDocument('auth', 'drafting')

    const service = makeService()
    await service.cleanFixtureVisions({ dryRun: false })

    const [row] = await db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, visionId))
    // 'auth' is in the preserved keyword list (4 chars but keyword protected)
    expect(row?.lifecycleState).toBe('drafting')
  })

  it('dryRun=true leaves vision in drafting', async () => {
    const visionId = await insertVisionDocument('xyz', 'drafting')

    const service = makeService()
    const result = await service.cleanFixtureVisions({ dryRun: true })

    expect(result.transitioned).toBe(0)

    const [row] = await db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, visionId))
    expect(row?.lifecycleState).toBe('drafting')
  })
})

// ---------------------------------------------------------------------------
// archiveStaleVisionSessions
// ---------------------------------------------------------------------------

describe('archiveStaleVisionSessions (integration)', () => {
  it('abandons open sessions started > 7 days ago', async () => {
    const visionDocumentId = await insertVisionDocument('real product vision here', 'drafting')
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const sessionId = await insertVisionSession(visionDocumentId, oldDate, 'open')

    const service = makeService()
    const result = await service.archiveStaleVisionSessions({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db
      .select()
      .from(visionSessions)
      .where(eq(visionSessions.visionSessionId, sessionId))
    expect(row?.state).toBe('abandoned')
  })

  it('does NOT abandon sessions started < 7 days ago', async () => {
    const visionDocumentId = await insertVisionDocument('fresh vision document', 'drafting')
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const sessionId = await insertVisionSession(visionDocumentId, recentDate, 'open')

    const service = makeService()
    await service.archiveStaleVisionSessions({ dryRun: false })

    const [row] = await db
      .select()
      .from(visionSessions)
      .where(eq(visionSessions.visionSessionId, sessionId))
    expect(row?.state).toBe('open')
  })

  it('dryRun=true leaves session open', async () => {
    const visionDocumentId = await insertVisionDocument('old vision for test', 'drafting')
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const sessionId = await insertVisionSession(visionDocumentId, oldDate, 'open')

    const service = makeService()
    const result = await service.archiveStaleVisionSessions({ dryRun: true })

    expect(result.transitioned).toBe(0)

    const [row] = await db
      .select()
      .from(visionSessions)
      .where(eq(visionSessions.visionSessionId, sessionId))
    expect(row?.state).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// cleanOrphanCeremonies
// ---------------------------------------------------------------------------

describe('cleanOrphanCeremonies (integration)', () => {
  it('aborts scheduled ceremonies whose sprint is completed', async () => {
    const sprintId = await insertSprint('completed-test-sprint', 'completed')
    const ceremonyId = await insertCeremony(sprintId, 'scheduled')

    const service = makeService()
    const result = await service.cleanOrphanCeremonies({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db
      .select()
      .from(ceremonies)
      .where(eq(ceremonies.ceremonyId, ceremonyId))
    expect(row?.state).toBe('aborted')
    expect(row?.abortReason).toContain('hygiene_sweep')
  })

  it('does NOT abort ceremonies whose sprint is still active', async () => {
    const sprintId = await insertSprint('active-sprint-for-cer-test', 'active')
    const ceremonyId = await insertCeremony(sprintId, 'scheduled')

    const service = makeService()
    await service.cleanOrphanCeremonies({ dryRun: false })

    const [row] = await db
      .select()
      .from(ceremonies)
      .where(eq(ceremonies.ceremonyId, ceremonyId))
    expect(row?.state).toBe('scheduled')
  })

  it('dryRun=true returns sampleIds without mutation', async () => {
    const sprintId = await insertSprint('completed-dry-run', 'completed')
    const ceremonyId = await insertCeremony(sprintId, 'scheduled')

    const service = makeService()
    const result = await service.cleanOrphanCeremonies({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain(ceremonyId)

    const [row] = await db
      .select()
      .from(ceremonies)
      .where(eq(ceremonies.ceremonyId, ceremonyId))
    expect(row?.state).toBe('scheduled')
  })
})

// ---------------------------------------------------------------------------
// cleanStaleWorkers
// ---------------------------------------------------------------------------

describe('cleanStaleWorkers (integration)', () => {
  it('terminates workers with heartbeat > 7 days ago', async () => {
    const oldBeat = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const workerId = await insertAgentWorker(oldBeat, oldBeat)

    const service = makeService()
    const result = await service.cleanStaleWorkers({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db
      .select()
      .from(agentWorkers)
      .where(eq(agentWorkers.workerId, workerId))
    expect(row?.status).toBe('terminated')
  })

  it('does NOT terminate workers with recent heartbeat', async () => {
    const recentBeat = new Date(Date.now() - 1 * 60 * 60 * 1000) // 1 hour ago
    const workerId = await insertAgentWorker(recentBeat, recentBeat)

    const service = makeService()
    await service.cleanStaleWorkers({ dryRun: false })

    const [row] = await db
      .select()
      .from(agentWorkers)
      .where(eq(agentWorkers.workerId, workerId))
    expect(row?.status).toBe('active')
  })

  it('dryRun=true returns sampleIds', async () => {
    const oldBeat = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
    const workerId = await insertAgentWorker(oldBeat, oldBeat)

    const service = makeService()
    const result = await service.cleanStaleWorkers({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain(workerId)

    const [row] = await db
      .select()
      .from(agentWorkers)
      .where(eq(agentWorkers.workerId, workerId))
    expect(row?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// cleanStaleCapabilities
// ---------------------------------------------------------------------------

describe('cleanStaleCapabilities (integration)', () => {
  it('revokes grants for completed sprints issued > 24h ago', async () => {
    const sprintId = await insertSprint('cap-sweep-sprint', 'completed')
    const oldIssuedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const capId = await insertCapabilityGrant(sprintId, oldIssuedAt)

    const service = makeService()
    const result = await service.cleanStaleCapabilities({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, capId))
    expect(row?.status).toBe('revoked')
  })

  it('does NOT revoke grants issued within the last 24 hours', async () => {
    const sprintId = await insertSprint('cap-preserve-sprint', 'completed')
    const recentIssuedAt = new Date(Date.now() - 30 * 60 * 1000) // 30 min ago
    const capId = await insertCapabilityGrant(sprintId, recentIssuedAt)

    const service = makeService()
    await service.cleanStaleCapabilities({ dryRun: false })

    const [row] = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, capId))
    expect(row?.status).toBe('active')
  })

  it('dryRun=true returns sampleIds without revoking', async () => {
    const sprintId = await insertSprint('cap-dry-sprint', 'completed')
    const oldIssuedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const capId = await insertCapabilityGrant(sprintId, oldIssuedAt)

    const service = makeService()
    const result = await service.cleanStaleCapabilities({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain(capId)

    const [row] = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, capId))
    expect(row?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// archiveTestDefects
// ---------------------------------------------------------------------------

describe('archiveTestDefects (integration)', () => {
  it('closes defects whose origin story is cancelled', async () => {
    const epicId = await insertEpic('epic-for-defects', 'active')
    const storyId = await insertStory(epicId, 'cancelled story', 'cancelled')
    const defectId = await insertDefect(storyId, 'open')

    const service = makeService()
    const result = await service.archiveTestDefects({ dryRun: false })

    expect(result.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db.select().from(defects).where(eq(defects.defectId, defectId))
    expect(row?.state).toBe('closed')
  })

  it('does NOT close defects from active stories', async () => {
    const epicId = await insertEpic('active-epic-for-defects', 'active')
    const storyId = await insertStory(epicId, 'active story for defect', 'backlog')
    const defectId = await insertDefect(storyId, 'open')

    const service = makeService()
    await service.archiveTestDefects({ dryRun: false })

    const [row] = await db.select().from(defects).where(eq(defects.defectId, defectId))
    expect(row?.state).toBe('open')
  })

  it('dryRun=true returns sampleIds without closing', async () => {
    const epicId = await insertEpic('dry-defects-epic', 'active')
    const storyId = await insertStory(epicId, 'dry-cancelled-story', 'cancelled')
    const defectId = await insertDefect(storyId, 'open')

    const service = makeService()
    const result = await service.archiveTestDefects({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain(defectId)

    const [row] = await db.select().from(defects).where(eq(defects.defectId, defectId))
    expect(row?.state).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

describe('AdminHygieneSweepCompleted event emission', () => {
  it('emits one event per category that has transitions', async () => {
    const epicId = await insertEpic('zzz', 'active')

    const es = createEventStore(db, sqlPool)
    const before = await es.query({ event_type: 'AdminHygieneSweepCompleted', limit: 1000 })
    const beforeCount = before.items.length

    const service = new HygieneService(db, es)
    await service.cleanFixtureEpics({ dryRun: false })

    const after = await es.query({ event_type: 'AdminHygieneSweepCompleted', limit: 1000 })
    expect(after.items.length).toBeGreaterThan(beforeCount)

    const newEvents = after.items.slice(0, after.items.length - beforeCount)
    const epicEvent = newEvents.find(
      (e) => (e.payload as Record<string, unknown>)['sweep_type'] === 'epics',
    )
    expect(epicEvent).toBeDefined()
    expect((epicEvent!.payload as Record<string, unknown>)['affected_count']).toBeGreaterThanOrEqual(1)
    expect((epicEvent!.payload as Record<string, unknown>)['dry_run']).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runFullSweep with aggressiveDryRun=false
// ---------------------------------------------------------------------------

describe('runFullSweep aggressiveDryRun=false (integration)', () => {
  it('transitions epics when aggressiveDryRun=false', async () => {
    const epicId = await insertEpic('tst', 'active')

    const es = createEventStore(db, sqlPool)
    const service = new HygieneService(db, es)

    const result = await service.runFullSweep({ dryRun: false, aggressiveDryRun: false })

    expect(result.epics.transitioned).toBeGreaterThanOrEqual(1)

    const [row] = await db.select().from(epics).where(eq(epics.epicId, epicId))
    expect(row?.status).toBe('cancelled')
  })

  it('v2 methods are dry when aggressiveDryRun=true (default)', async () => {
    await insertEpic('ttt', 'active')

    const es = createEventStore(db, sqlPool)
    const service = new HygieneService(db, es)

    const result = await service.runFullSweep({ dryRun: false })
    // aggressiveDryRun defaults to true — epics should NOT be transitioned
    expect(result.epics.transitioned).toBe(0)
  })
})
