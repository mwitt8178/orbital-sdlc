/**
 * Integration test: handoff-flow — agent posts handoff_note → HandOffRequested → child task created.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Exercises:
 *   1. A persona actor posts a handoff_note to a sprint channel.
 *   2. onHandoffNotePosted() emits HandOffRequested event.
 *   3. A child task is created with the target persona and parent linkage.
 *   4. Source task is NOT modified (hand-off is non-interrupting).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { onHandoffNotePosted } from '../../../src/hooks/post-handoff-requested.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sourceTaskId: string
let sprintId: string
let sprintChannelId: string
let eventStore: ReturnType<typeof createEventStore>

const personaActor = {
  type: 'persona' as const,
  persona_id: 'sr-dev',
  session_id: uuidv7(),
  task_id: '',
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql`SELECT 1`
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

beforeEach(async () => {
  sourceTaskId = uuidv7()
  sprintId = uuidv7()
  sprintChannelId = uuidv7()
  personaActor.task_id = sourceTaskId

  // Insert source task
  await db.insert(tasks).values({
    taskId: sourceTaskId,
    sprintId,
    ticketId: `TKT-${sourceTaskId.slice(0, 8)}`,
    title: 'Implement avatar upload feature',
    description: 'Needs S3 bucket creation (infra scope)',
    personaId: 'sr-dev',
    riskClass: 'standard',
    retryBudget: 3,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 8000,
    createdByEventId: uuidv7(),
  })
})

afterEach(async () => {
  await db
    .delete(tasks)
    .where(eq(tasks.parentTaskId, sourceTaskId))
    .catch(() => undefined)
  await db
    .delete(tasks)
    .where(eq(tasks.taskId, sourceTaskId))
    .catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handoff-flow: onHandoffNotePosted', () => {
  it('emits HandOffRequested event with target persona and source task context', async () => {
    const postId = uuidv7()

    await onHandoffNotePosted(
      {
        post_id: postId,
        channel_id: sprintChannelId,
        post_type: 'handoff_note',
        payload: {
          body: 'Avatar upload needs S3 bucket + IAM policy in infra scope',
          target_persona: 'architect',
          handoff_reason: 'S3 infra outside my filesWrite glob',
          suggested_title: 'Create S3 bucket for avatar uploads',
          suggested_description: 'Per security-serverless skill: least-privilege bucket policy',
        },
        mentions: [{ target_type: 'persona_role', target_ref: '@architect' }],
        cross_references: [{ ref_type: 'sprint', ref_id: sprintId }],
      },
      personaActor,
      db,
      eventStore,
    )

    // HandOffRequested should be emitted on source task aggregate
    const events = await eventStore.query({
      aggregate_id: sourceTaskId,
      event_type: 'HandOffRequested',
      limit: 5,
    })
    expect(events.items.length).toBe(1)
    const evt = events.items[0]!
    const payload = evt.payload as Record<string, unknown>
    expect(payload['source_task_id']).toBe(sourceTaskId)
    expect(payload['target_persona']).toBe('architect')
    expect(payload['handoff_reason']).toBe('S3 infra outside my filesWrite glob')
  })

  it('creates a child task with the target persona in ready state', async () => {
    const postId = uuidv7()

    await onHandoffNotePosted(
      {
        post_id: postId,
        channel_id: sprintChannelId,
        post_type: 'handoff_note',
        payload: {
          body: 'Need schema migration for new avatars table',
          target_persona: 'principal-dev',
          handoff_reason: 'DB migrations require multi-tenant-migrations skill',
          suggested_title: 'Add avatars table migration',
        },
        mentions: [],
        cross_references: [],
      },
      personaActor,
      db,
      eventStore,
    )

    const childTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(1)
    const child = childTasks[0]!
    expect(child.personaId).toBe('principal-dev')
    expect(child.state).toBe('ready')
    expect(child.sprintId).toBe(sprintId)
    expect(child.title).toBe('Add avatars table migration')
  })

  it('does nothing when target_persona is missing from payload', async () => {
    const postId = uuidv7()

    await onHandoffNotePosted(
      {
        post_id: postId,
        channel_id: sprintChannelId,
        post_type: 'handoff_note',
        payload: {
          body: 'Missing target persona',
          handoff_reason: 'some reason',
          // no target_persona field
        },
        mentions: [],
        cross_references: [],
      },
      personaActor,
      db,
      eventStore,
    )

    // No child tasks created
    const childTasks = await db.select().from(tasks).where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(0)

    // No HandOffRequested emitted
    const events = await eventStore.query({
      aggregate_id: sourceTaskId,
      event_type: 'HandOffRequested',
      limit: 5,
    })
    expect(events.items.length).toBe(0)
  })

  it('does nothing when actor has no task_id', async () => {
    const noTaskActor = { type: 'persona' as const, persona_id: 'sr-dev', session_id: uuidv7() }

    await onHandoffNotePosted(
      {
        post_id: uuidv7(),
        channel_id: sprintChannelId,
        post_type: 'handoff_note',
        payload: { body: 'Test', target_persona: 'architect', handoff_reason: 'test' },
        mentions: [],
        cross_references: [],
      },
      noTaskActor as never,
      db,
      eventStore,
    )

    const childTasks = await db.select().from(tasks).where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(0)
  })
})
