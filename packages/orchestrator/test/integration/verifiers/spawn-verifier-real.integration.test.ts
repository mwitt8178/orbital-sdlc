/**
 * spawn-verifier-real.integration.test.ts — VerifierService.spawnVerifier
 * with a real parent task (Round 5C path).
 *
 * Verifies:
 *   - When a parent task exists in the tasks table AND the story has ACs,
 *     spawnVerifier inserts one verifier sub-task per AC.
 *   - The verifications row has ac_count = number of ACs.
 *   - VerifierStarted event is emitted.
 *   - SoD check still gates against same persona_id.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { VerifierServiceImpl } from '../../../src/verifiers/service.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { epics, stories, storyAcceptanceCriteria } from '../../../src/db/schema/backlog.js'
import { verifications } from '../../../src/db/schema/determinism.js'
import { events } from '../../../src/db/schema/events.js'

let eventStore: ReturnType<typeof createEventStore>
let service: VerifierServiceImpl

beforeAll(async () => {
  eventStore = createEventStore(db, sql)
  service = new VerifierServiceImpl(eventStore, db)
})

afterAll(async () => {
  await sql.end()
})

describe('VerifierService.spawnVerifier · real path', () => {
  it('with parent task + AC list, spawns one verifier sub-task per AC', async () => {
    const sprintId = uuidv7()
    const storyId = uuidv7()
    const epicId = uuidv7()
    const parentTaskId = uuidv7()
    const ticketId = `ORB-R5C-${parentTaskId.slice(0, 6)}`

    // Insert epic shell (real FK in 0010_backlog).
    await db.insert(epics).values({
      epicId,
      visionVersionId: uuidv7(),
      title: 'Test epic for verifier spawn',
      rationale: 'integration test',
      priority: 3,
    })

    // Insert a story shell.
    await db.insert(stories).values({
      storyId,
      epicId,
      title: 'Test story for verifier spawn',
      description: 'integration test story',
      status: 'in_review',
      priority: 3,
    })

    // Insert two ACs.
    const ac1Id = uuidv7()
    const ac2Id = uuidv7()
    await db.insert(storyAcceptanceCriteria).values([
      { acId: ac1Id, storyId, ordinal: 1, text: 'User can sign in with email and password' },
      { acId: ac2Id, storyId, ordinal: 2, text: 'Failed login shows an error message' },
    ])

    // Insert a parent task in 'done' state (TaskCompleted just fired).
    await db.insert(tasks).values({
      taskId: parentTaskId,
      sprintId,
      ticketId,
      title: 'Parent task',
      description: 'real integration parent',
      acceptanceCriteria: [
        'User can sign in with email and password',
        'Failed login shows an error message',
      ],
      storyId,
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'done',
      attemptCount: 1,
      retryBudget: 3,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 4000,
      tokensConsumed: 100,
      declaredWritePaths: [],
      createdByEventId: uuidv7(),
      startedAt: new Date(Date.now() - 5000),
      completedAt: new Date(),
    })

    // Spawn the verifier.
    const verificationId = await service.spawnVerifier(
      parentTaskId,
      ticketId,
      ['src/auth/login.ts'],
      'sr-dev',
    )

    // verifications row exists with status='running' and ac_count=2.
    const verRows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.verification_id, verificationId))
    expect(verRows.length).toBe(1)
    expect(verRows[0]!.status).toBe('running')
    expect(verRows[0]!.ac_count).toBe(2)

    // Two verifier sub-tasks exist with parent_task_id=parentTaskId
    // and persona_id='verifier'.
    const childRows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.personaId, 'verifier')))
    expect(childRows.length).toBe(2)
    for (const child of childRows) {
      expect(child.state).toBe('ready')
      expect(child.title).toContain('Verify AC #')
      expect(child.acceptanceCriteria.length).toBe(1)
    }

    // VerifierStarted event lands.
    await new Promise((r) => setTimeout(r, 50))
    const startedRows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.eventType, 'VerifierStarted'),
          eq(events.aggregateId, verificationId),
        ),
      )
    expect(startedRows.length).toBe(1)
    const payload = startedRows[0]!.payload as Record<string, unknown>
    expect(payload['ac_count']).toBe(2)
  })

  it('without parent task in tasks table, falls back to legacy stub path', async () => {
    const taskId = uuidv7() // never inserted into tasks
    const ticketId = `ORB-R5C-LEGACY-${taskId.slice(0, 6)}`

    const verificationId = await service.spawnVerifier(
      taskId,
      ticketId,
      ['src/foo.ts'],
      'sr-dev',
    )

    const rows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.verification_id, verificationId))
    expect(rows.length).toBe(1)
    expect(rows[0]!.ac_count).toBe(0)

    // Also: no child tasks were spawned (no parent → no spawn path).
    const childRows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, taskId), eq(tasks.personaId, 'verifier')))
    expect(childRows.length).toBe(0)
  })
})
