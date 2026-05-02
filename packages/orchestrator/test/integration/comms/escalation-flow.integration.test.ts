/**
 * Integration test: escalation-flow — agent posts escalation → EscalationRaised → child task created.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Exercises:
 *   1. A persona actor posts an escalation_note to an #escalation-* channel.
 *   2. onEscalationNotePosted() is called directly (bypasses gateway; the gateway
 *      is tested in capability-gate test).
 *   3. EscalationRaised event is written to the event store.
 *   4. A child task is created with persona=target_persona_hint.
 *   5. The source task's escalation_count is incremented.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { channels } from '../../../src/db/schema/channels.js'
import { onEscalationNotePosted } from '../../../src/hooks/post-escalation-raised.js'
import type { ChannelId } from '@orbital/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sourceTaskId: string
let sprintId: string
let escalationChannelId: ChannelId
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
  personaActor.task_id = sourceTaskId

  // Insert source task
  await db.insert(tasks).values({
    taskId: sourceTaskId,
    sprintId,
    ticketId: `TKT-${sourceTaskId.slice(0, 8)}`,
    title: 'Implement OCC retry logic',
    description: 'Source task for escalation test',
    personaId: 'sr-dev',
    riskClass: 'standard',
    retryBudget: 2,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 8000,
    createdByEventId: uuidv7(),
  })

  // Ensure escalation channel exists
  const channelName = `#escalation-${sprintId.slice(0, 8)}` as const
  const existing = await db
    .select()
    .from(channels)
    .where(eq(channels.name, channelName))
    .limit(1)

  if (existing[0]) {
    escalationChannelId = existing[0].channelId as ChannelId
  } else {
    const newChannelId = uuidv7()
    await db.insert(channels).values({
      channelId: newChannelId as ChannelId,
      name: channelName,
      kind: 'topic',
      scopeRef: { sprint_id: sprintId },
      createdByActor: { type: 'system', component: 'test-fixture' },
      schemaVersion: 1,
    })
    escalationChannelId = newChannelId as ChannelId
  }
})

afterEach(async () => {
  // Clean up child tasks
  await db
    .delete(tasks)
    .where(eq(tasks.parentTaskId, sourceTaskId))
    .catch(() => undefined)
  // Clean up source task
  await db
    .delete(tasks)
    .where(eq(tasks.taskId, sourceTaskId))
    .catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escalation-flow: onEscalationNotePosted', () => {
  it('emits EscalationRaised event when an escalation_note is posted to an escalation channel', async () => {
    const postId = uuidv7()

    await onEscalationNotePosted(
      {
        post_id: postId,
        channel_id: escalationChannelId,
        post_type: 'escalation_note',
        payload: {
          body: 'Blocked on DSQL serialization_failure after 3 retries',
          confidence: 62,
          blocker_type: 'retry_budget_exhausted',
        },
        mentions: [{ target_type: 'persona_role', target_ref: '@principal-dev' }],
        cross_references: [{ ref_type: 'sprint', ref_id: sprintId }],
      },
      personaActor,
      db,
      eventStore,
    )

    // EscalationRaised should be emitted
    const events = await eventStore.query({
      aggregate_id: sourceTaskId,
      event_type: 'EscalationRaised',
      limit: 5,
    })
    expect(events.items.length).toBe(1)
    const evt = events.items[0]!
    const payload = evt.payload as Record<string, unknown>
    expect(payload['source_task_id']).toBe(sourceTaskId)
    expect(payload['target_persona_hint']).toBe('principal-dev')
    expect(payload['confidence']).toBe(62)
    expect(payload['raised_by_persona']).toBe('sr-dev')
  })

  it('creates a child task with target persona and parent_task_id linking to source', async () => {
    const postId = uuidv7()

    await onEscalationNotePosted(
      {
        post_id: postId,
        channel_id: escalationChannelId,
        post_type: 'escalation_note',
        payload: {
          body: 'Architecture decision needed for cross-service transaction',
          confidence: 70,
          blocker_type: 'low_confidence',
        },
        mentions: [{ target_type: 'persona_role', target_ref: '@em' }],
        cross_references: [],
      },
      personaActor,
      db,
      eventStore,
    )

    // Child task should exist with correct parent and persona
    const childTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(1)
    const child = childTasks[0]!
    expect(child.personaId).toBe('em')
    expect(child.state).toBe('ready')
    expect(child.sprintId).toBe(sprintId)
    expect(child.title).toContain('Escalation:')
  })

  it('increments escalation_count on the source task', async () => {
    const postId = uuidv7()

    const [before] = await db.select().from(tasks).where(eq(tasks.taskId, sourceTaskId)).limit(1)
    const initialCount = before?.escalationCount ?? 0

    await onEscalationNotePosted(
      {
        post_id: postId,
        channel_id: escalationChannelId,
        post_type: 'escalation_note',
        payload: {
          body: 'Test escalation count increment',
          confidence: 65,
          blocker_type: 'low_confidence',
        },
        mentions: [],
        cross_references: [],
      },
      personaActor,
      db,
      eventStore,
    )

    const [after] = await db.select().from(tasks).where(eq(tasks.taskId, sourceTaskId)).limit(1)
    expect(after?.escalationCount).toBe(initialCount + 1)
  })

  it('does nothing when actor has no task_id', async () => {
    const noTaskActor = { type: 'persona' as const, persona_id: 'sr-dev', session_id: uuidv7() }
    const postId = uuidv7()

    // Should not throw
    await onEscalationNotePosted(
      {
        post_id: postId,
        channel_id: escalationChannelId,
        post_type: 'escalation_note',
        payload: { body: 'Test', confidence: 60, blocker_type: 'low_confidence' },
        mentions: [],
        cross_references: [],
      },
      noTaskActor as never,
      db,
      eventStore,
    )

    // No child tasks created
    const childTasks = await db.select().from(tasks).where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(0)
  })

  it('does nothing when channel is not an escalation channel', async () => {
    // Create a sprint channel (not escalation)
    const sprintChannelId = uuidv7()
    await db.insert(channels).values({
      channelId: sprintChannelId as ChannelId,
      name: `#sprint-${sprintId.slice(0, 8)}`,
      kind: 'sprint',
      scopeRef: { sprint_id: sprintId },
      createdByActor: { type: 'system', component: 'test-fixture' },
      schemaVersion: 1,
    })

    const postId = uuidv7()

    await onEscalationNotePosted(
      {
        post_id: postId,
        channel_id: sprintChannelId,
        post_type: 'escalation_note',
        payload: { body: 'Test', confidence: 60, blocker_type: 'low_confidence' },
        mentions: [],
        cross_references: [],
      },
      personaActor,
      db,
      eventStore,
    )

    // No child tasks created (not an escalation channel)
    const childTasks = await db.select().from(tasks).where(eq(tasks.parentTaskId, sourceTaskId))
    expect(childTasks.length).toBe(0)

    // Cleanup
    await db.delete(channels).where(eq(channels.channelId, sprintChannelId as ChannelId))
  })
})
