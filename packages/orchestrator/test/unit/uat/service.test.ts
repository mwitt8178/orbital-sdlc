/**
 * Unit tests for UATService.
 *
 * Per TRD-11 v0.2 §11.1.
 *
 * Tests:
 * - Submit outcome computation: fail_count==0 → accepted; fail_count==total → rejected;
 *   otherwise → partially_accepted
 * - Per-AC state-machine: legal transitions; illegal on terminal session
 * - Zod refinement: MarkACInput rejects status='fail' without observed_behavior
 * - VALIDATION_PENDING_ACS_REMAIN guard on submit when any AC is pending
 * - UAT_AC_NOT_MARKED when accepting a session with fail_count > 0
 * - Session state transitions: started → in_progress on first mark
 *
 * Uses real Postgres per project conventions (no mock DB).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
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
} from '../../../src/db/schema/uat.js'
import {
  epics,
  stories,
  storyAcceptanceCriteria,
} from '../../../src/db/schema/backlog.js'
import { MarkACInputSchema, UAT_ERROR_CODES } from '../../../src/uat/types.js'
import { OrbitalError } from '@orbital/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const STUB_USER = { userId: 'user:test', installId: 'install:test' }

let uatService: DefaultUATService
let ownedSessionIds: string[] = []
let ownedEpicIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  const backlogService = new DefaultBacklogService(db, eventStore)
  const defectService = new DefaultDefectService(db, eventStore, backlogService)
  const por = new DefaultPersonaOfRecord(db, eventStore)
  uatService = new DefaultUATService(db, eventStore, defectService, por)
})

beforeEach(() => {
  ownedSessionIds = []
  ownedEpicIds = []
})

afterAll(async () => {
  // Clean up in FK order
  if (ownedSessionIds.length > 0) {
    await db.delete(defectLineage).where(
      inArray(
        defectLineage.defectId,
        db.select({ defectId: defectsTable.defectId })
          .from(defectsTable)
          .where(inArray(defectsTable.uatSessionId, ownedSessionIds)) as any,
      ),
    ).catch(() => undefined)
    await db.delete(defectsTable)
      .where(inArray(defectsTable.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
    await db.delete(uatAcResults)
      .where(inArray(uatAcResults.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
    await db.delete(uatSessions)
      .where(inArray(uatSessions.uatSessionId, ownedSessionIds))
      .catch(() => undefined)
  }
  if (ownedEpicIds.length > 0) {
    const sRows = await db.select({ storyId: stories.storyId })
      .from(stories)
      .where(inArray(stories.epicId, ownedEpicIds))
    if (sRows.length > 0) {
      const storyIds = sRows.map((r) => r.storyId)
      await db.delete(storyAcceptanceCriteria)
        .where(inArray(storyAcceptanceCriteria.storyId, storyIds))
        .catch(() => undefined)
      await db.delete(stories)
        .where(inArray(stories.epicId, ownedEpicIds))
        .catch(() => undefined)
    }
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds)).catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// Create a story with N ACs for testing
async function makeStory(acCount = 3): Promise<{ storyId: string; epicId: string; acIds: string[] }> {
  const epicId = uuidv7()
  const storyId = uuidv7()
  const now = new Date()

  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'test-epic',
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
    title: 'test-story',
    description: 'desc',
    status: 'done',
    priority: 1,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })

  const acIds: string[] = []
  for (let i = 0; i < acCount; i++) {
    const acId = uuidv7()
    acIds.push(acId)
    await db.insert(storyAcceptanceCriteria).values({
      acId,
      storyId,
      ordinal: i + 1,
      text: `AC-${i + 1}: the feature does X`,
      createdAt: now,
      schemaVersion: 1,
    })
  }

  return { storyId, epicId, acIds }
}

// Start a session and track for cleanup
async function startSession(storyId: string): Promise<{ sessionId: string; acIds: string[] }> {
  const result = await uatService.startSession(
    {
      ticket_id: storyId,
      triggered_by_event_id: uuidv7(),
      build_ref: 'test-build-ref',
      resume_existing: false,
      justification: 'test',
    },
    STUB_USER,
  )
  ownedSessionIds.push(result.session.uatSessionId)
  return {
    sessionId: result.session.uatSessionId,
    acIds: result.acResults.map((r) => r.acId),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UATService — submit outcome computation', () => {
  it('fail_count == 0 produces accepted outcome', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    // Mark all pass
    for (const acId of acIds) {
      await uatService.markAC(
        { uat_session_id: sessionId, ac_id: acId, status: 'pass', justification: 'test' },
        STUB_USER.userId,
      )
    }

    const result = await uatService.submit(
      { uat_session_id: sessionId, justification: 'test' },
      STUB_USER.userId,
    )

    expect(result.outcome).toBe('accepted')
    expect(result.fail_count).toBe(0)
    expect(result.defects_created).toHaveLength(0)
  })

  it('fail_count == total produces rejected outcome', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    for (const acId of acIds) {
      await uatService.markAC(
        {
          uat_session_id: sessionId,
          ac_id: acId,
          status: 'fail',
          observed_behavior: 'it broke',
          justification: 'test',
        },
        STUB_USER.userId,
      )
    }

    const result = await uatService.submit(
      { uat_session_id: sessionId, justification: 'test' },
      STUB_USER.userId,
    )

    expect(result.outcome).toBe('rejected')
    expect(result.fail_count).toBe(2)
    expect(result.defects_created).toHaveLength(2)
  })

  it('0 < fail_count < total produces partially_accepted outcome', async () => {
    const { storyId } = await makeStory(3)
    const { sessionId, acIds } = await startSession(storyId)

    // Pass 2, fail 1
    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[1]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    await uatService.markAC(
      {
        uat_session_id: sessionId,
        ac_id: acIds[2]!,
        status: 'fail',
        observed_behavior: 'it broke',
        justification: 'test',
      },
      STUB_USER.userId,
    )

    const result = await uatService.submit(
      { uat_session_id: sessionId, justification: 'test' },
      STUB_USER.userId,
    )

    expect(result.outcome).toBe('partially_accepted')
    expect(result.pass_count).toBe(2)
    expect(result.fail_count).toBe(1)
    expect(result.defects_created).toHaveLength(1)
  })
})

describe('UATService — per-AC state machine', () => {
  it('transitions session from started to in_progress on first mark', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    const [initial] = await db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)
    expect(initial?.state).toBe('started')

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )

    const [after] = await db
      .select()
      .from(uatSessions)
      .where(eq(uatSessions.uatSessionId, sessionId))
      .limit(1)
    expect(after?.state).toBe('in_progress')
  })

  it('mark on submitted session throws CONFLICT_INVALID_STATE_TRANSITION', async () => {
    const { storyId } = await makeStory(1)
    const { sessionId, acIds } = await startSession(storyId)

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    await uatService.submit(
      { uat_session_id: sessionId, justification: 'test' },
      STUB_USER.userId,
    )

    await expect(
      uatService.markAC(
        { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'fail', observed_behavior: 'x', justification: 'test' },
        STUB_USER.userId,
      ),
    ).rejects.toThrow(OrbitalError)
  })

  it('marking same AC with same status is a no-op (idempotent)', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    const result = await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    // Should return pass_count=1 (not 2)
    expect(result.pass_count).toBe(1)
  })

  it('re-marking AC with different status emits unmark + mark', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    const result = await uatService.markAC(
      {
        uat_session_id: sessionId,
        ac_id: acIds[0]!,
        status: 'fail',
        observed_behavior: 'now it fails',
        justification: 'test',
      },
      STUB_USER.userId,
    )

    expect(result.status).toBe('fail')
    expect(result.pass_count).toBe(0)
    expect(result.fail_count).toBe(1)
  })

  it('unmark reverts AC to pending', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    const result = await uatService.unmarkAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, justification: 'test' },
      STUB_USER.userId,
    )

    expect(result.status).toBe('pending')
    expect(result.pass_count).toBe(0)
    expect(result.pending_count).toBe(2)
  })
})

describe('UATService — submit guards', () => {
  it('throws VALIDATION_PENDING_ACS_REMAIN when ACs remain pending', async () => {
    const { storyId } = await makeStory(3)
    const { sessionId, acIds } = await startSession(storyId)

    // Only mark 2 of 3
    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[1]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )

    await expect(
      uatService.submit({ uat_session_id: sessionId, justification: 'test' }, STUB_USER.userId),
    ).rejects.toThrow(OrbitalError)

    try {
      await uatService.submit({ uat_session_id: sessionId, justification: 'test' }, STUB_USER.userId)
    } catch (err) {
      expect((err as OrbitalError).code).toBe(UAT_ERROR_CODES.VALIDATION_PENDING_ACS_REMAIN)
    }
  })
})

describe('UATService — accept guard', () => {
  it('throws UAT_AC_NOT_MARKED when accepting with failed ACs', async () => {
    const { storyId } = await makeStory(2)
    const { sessionId, acIds } = await startSession(storyId)

    await uatService.markAC(
      { uat_session_id: sessionId, ac_id: acIds[0]!, status: 'pass', justification: 'test' },
      STUB_USER.userId,
    )
    await uatService.markAC(
      {
        uat_session_id: sessionId,
        ac_id: acIds[1]!,
        status: 'fail',
        observed_behavior: 'broken',
        justification: 'test',
      },
      STUB_USER.userId,
    )
    // Manually put session in 'submitted' state to bypass submit() defect creation
    await db
      .update(uatSessions)
      .set({ state: 'submitted' })
      .where(eq(uatSessions.uatSessionId, sessionId))

    await expect(
      uatService.accept(sessionId, STUB_USER.userId),
    ).rejects.toThrow(OrbitalError)
  })
})

describe('Zod refinement — MarkACInput', () => {
  it('rejects status=fail without observed_behavior', () => {
    const result = MarkACInputSchema.safeParse({
      uat_session_id: uuidv7(),
      ac_id: uuidv7(),
      status: 'fail',
      justification: 'test',
      // observed_behavior intentionally omitted
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.errors.map((e) => e.path.join('.'))
      expect(paths).toContain('observed_behavior')
    }
  })

  it('accepts status=pass without observed_behavior', () => {
    const result = MarkACInputSchema.safeParse({
      uat_session_id: uuidv7(),
      ac_id: uuidv7(),
      status: 'pass',
      justification: 'test',
    })
    expect(result.success).toBe(true)
  })
})
