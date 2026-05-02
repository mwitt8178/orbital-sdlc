/**
 * Integration test: PROpened → reviewer task created.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Emits a PROpened event → asserts that:
 *   1. A child task is created with persona=reviewer, parent_task_id=author_task
 *   2. tasks.code_review_state = 'awaiting_review' is set on the author task
 *   3. CodeReviewStarted event is appended to the event store
 *   4. Idempotency: a second PROpened for the same author task does NOT create
 *      a second reviewer task
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { onPROpened } from '../../../src/hooks/post-pr-opened.js'
import type { EventEnvelope } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testAuthorTaskId: string
let testSprintId: string
let testReviewerTaskId: string
let eventStore: ReturnType<typeof createEventStore>

function makePROpenedEnvelope(authorTaskId: string, prNumber: number): EventEnvelope {
  const envelopeId = uuidv7()
  return {
    event_id: envelopeId,
    aggregate_id: authorTaskId,
    aggregate_type: 'task',
    event_type: 'PROpened',
    payload: {
      task_id: authorTaskId,
      pr_number: prNumber,
      html_url: `https://github.com/test-owner/test-repo/pull/${prNumber}`,
      owner: 'test-owner',
      repo: 'test-repo',
      branch: `agent/${authorTaskId}`,
      head_sha: 'abc123',
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
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
  testAuthorTaskId = uuidv7()
  testSprintId = uuidv7()

  // Insert the author task
  await db.insert(tasks).values({
    taskId: testAuthorTaskId,
    sprintId: testSprintId,
    ticketId: `TKT-${testAuthorTaskId.slice(0, 8)}`,
    title: 'Implement feature X',
    description: 'Author task description',
    personaId: 'engineer-sr',
    riskClass: 'standard',
    retryBudget: 2,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 8000,
    createdByEventId: uuidv7(),
  })
})

afterEach(async () => {
  // Clean up any reviewer tasks created
  await db
    .delete(tasks)
    .where(eq(tasks.parentTaskId, testAuthorTaskId))
    .catch(() => undefined)

  await db
    .delete(tasks)
    .where(eq(tasks.taskId, testAuthorTaskId))
    .catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('post-pr-opened hook', () => {
  it('creates a reviewer child task on PROpened', async () => {
    const envelope = makePROpenedEnvelope(testAuthorTaskId, 42)

    await onPROpened(envelope, { db, eventStore })

    // Assert reviewer task was created
    const reviewerTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, testAuthorTaskId))

    expect(reviewerTasks.length).toBe(1)
    const reviewerTask = reviewerTasks[0]!

    expect(reviewerTask.personaId).toBe('reviewer')
    expect(reviewerTask.parentTaskId).toBe(testAuthorTaskId)
    expect(reviewerTask.title).toContain('Review PR #42')
    expect(reviewerTask.state).toBe('ready')
    // Reviewer writes nothing
    expect(reviewerTask.declaredWritePaths).toEqual([])
    // AC includes no CHANGES_REQUESTED
    expect(reviewerTask.acceptanceCriteria).toEqual(
      expect.arrayContaining([expect.stringContaining('No CHANGES_REQUESTED')]),
    )

    testReviewerTaskId = reviewerTask.taskId
  })

  it('sets code_review_state = awaiting_review on author task', async () => {
    const envelope = makePROpenedEnvelope(testAuthorTaskId, 43)

    await onPROpened(envelope, { db, eventStore })

    const [authorTask] = await db
      .select({ codeReviewState: tasks.codeReviewState })
      .from(tasks)
      .where(eq(tasks.taskId, testAuthorTaskId))
      .limit(1)

    expect(authorTask?.codeReviewState).toBe('awaiting_review')
  })

  it('emits CodeReviewStarted event', async () => {
    const traceId = uuidv7()
    const envelope = makePROpenedEnvelope(testAuthorTaskId, 44)
    envelope.trace_id = traceId

    await onPROpened(envelope, { db, eventStore })

    // Query events for CodeReviewStarted on this author task
    const { items } = await eventStore.query({
      aggregate_id: testAuthorTaskId,
    })

    const reviewStarted = items.find((e) => e.event_type === 'CodeReviewStarted')
    expect(reviewStarted).toBeDefined()
    const payload = reviewStarted!.payload as Record<string, unknown>
    expect(payload['author_task_id']).toBe(testAuthorTaskId)
    expect(payload['reviewer_persona_id']).toBe('reviewer')
    expect(payload['pr_number']).toBe(44)
  })

  it('is idempotent: second PROpened does not create a second reviewer task', async () => {
    const envelope = makePROpenedEnvelope(testAuthorTaskId, 45)

    // Fire twice
    await onPROpened(envelope, { db, eventStore })
    await onPROpened(envelope, { db, eventStore })

    // Should still only have one reviewer task
    const reviewerTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, testAuthorTaskId))

    const reviewerCount = reviewerTasks.filter((t) => t.personaId === 'reviewer').length
    expect(reviewerCount).toBe(1)
  })

  it('skips gracefully when author task does not exist', async () => {
    const nonExistentTaskId = uuidv7()
    const envelope = makePROpenedEnvelope(nonExistentTaskId, 99)

    // Should not throw
    await expect(onPROpened(envelope, { db, eventStore })).resolves.toBeUndefined()
  })

  it('reviewer task has same sprintId and ticketId as author task', async () => {
    const envelope = makePROpenedEnvelope(testAuthorTaskId, 46)

    await onPROpened(envelope, { db, eventStore })

    const [reviewerTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, testAuthorTaskId))
      .limit(1)

    expect(reviewerTask?.sprintId).toBe(testSprintId)
    expect(reviewerTask?.ticketId).toBe(`TKT-${testAuthorTaskId.slice(0, 8)}`)
  })
})
