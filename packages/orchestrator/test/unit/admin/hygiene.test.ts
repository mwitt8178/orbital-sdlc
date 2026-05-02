/**
 * unit/admin/hygiene.test.ts — HygieneService unit tests.
 *
 * Uses the real Postgres DB (per project convention — no mocks) and a real
 * EventStore. Each test inserts its own fixture data in an isolated set of rows
 * and verifies idempotency + no-delete semantics.
 *
 * TDD: RED → GREEN → REFACTOR
 *
 * Covers:
 *   - cleanFixtureStories: matches title < 3 chars or /^(s|x|test)[0-9]?$/
 *   - cleanFixtureStories: skips already-cancelled rows (idempotent)
 *   - cleanFixtureSprints: matches single-char names
 *   - cleanFixtureSprints: matches [DEMO] prefix
 *   - cleanFixtureSprints: skips already-completed rows (idempotent)
 *   - cleanStaleEscalations: with olderThanDays=0 sweeps all open
 *   - cleanStaleEscalations: skips non-open states (idempotent)
 *   - dryRun=true never commits changes
 *   - runFullSweep combines all three
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql as sqlPool, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { HygieneService } from '../../../src/admin/hygiene.js'
import { stories, sprints, epics } from '../../../src/db/schema/backlog.js'
import { escalations } from '../../../src/db/schema/orchestration.js'

// ---------------------------------------------------------------------------
// Test-row IDs — tracked so afterEach can clean up
// ---------------------------------------------------------------------------

const cleanup = {
  epicIds: [] as string[],
  storyIds: [] as string[],
  sprintIds: [] as string[],
  escalationIds: [] as string[],
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Inserts a minimal epic and returns its epic_id. */
async function insertEpic(): Promise<string> {
  const epicId = uuidv7()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'Test epic',
    rationale: 'hygiene test',
    priority: 999,
    status: 'active',
    schemaVersion: 1,
  })
  cleanup.epicIds.push(epicId)
  return epicId
}

/** Inserts a story with the given title and status, returns story_id. */
async function insertStory(
  epicId: string,
  title: string,
  status = 'backlog',
): Promise<string> {
  const storyId = uuidv7()
  await db.insert(stories).values({
    storyId,
    epicId,
    title,
    description: 'hygiene test story',
    status,
    priority: 0,
    schemaVersion: 1,
  })
  cleanup.storyIds.push(storyId)
  return storyId
}

/** Inserts a sprint with the given name and status, returns sprint_id. */
async function insertSprint(
  name: string,
  status: 'planning' | 'ready' | 'active' | 'completing' | 'completed' | 'paused' = 'active',
): Promise<string> {
  const sprintId = uuidv7()
  await db.insert(sprints).values({
    sprintId,
    name,
    sequence: 9999,
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

/** Inserts an escalation with the given state, returns escalation_id. */
async function insertEscalation(
  state: 'open' | 'acknowledged' | 'resolved' | 'cancelled' = 'open',
  createdDaysAgo = 0,
): Promise<string> {
  const escalationId = uuidv7()
  const taskId = uuidv7()
  const createdAt = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000)
  await db.insert(escalations).values({
    escalationId,
    taskId,
    reason: 'retry_budget_exhausted',
    triggeringEventId: uuidv7(),
    context: { test: true },
    state,
    createdAt,
  })
  cleanup.escalationIds.push(escalationId)
  return escalationId
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const es = createEventStore(db, sqlPool)
const svc = new HygieneService(db, es)

beforeEach(() => {
  cleanup.epicIds.length = 0
  cleanup.storyIds.length = 0
  cleanup.sprintIds.length = 0
  cleanup.escalationIds.length = 0
})

afterEach(async () => {
  // Delete in dependency order to satisfy FK constraints.
  if (cleanup.escalationIds.length > 0) {
    await db.delete(escalations).where(inArray(escalations.escalationId, cleanup.escalationIds))
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
// cleanFixtureStories
// ---------------------------------------------------------------------------

describe('HygieneService.cleanFixtureStories', () => {
  it('cancels a story with single-char title', async () => {
    const epicId = await insertEpic()
    const id = await insertStory(epicId, 's')

    const result = await svc.cleanFixtureStories({ dryRun: false })

    expect(result.archived).toBeGreaterThanOrEqual(1)
    const match = result.items.find((i) => i.storyId === id)
    expect(match).toBeDefined()

    const [row] = await db.select().from(stories).where(eq(stories.storyId, id))
    expect(row?.status).toBe('cancelled')
  })

  it('cancels a story with title "x"', async () => {
    const epicId = await insertEpic()
    const id = await insertStory(epicId, 'x')

    const result = await svc.cleanFixtureStories({ dryRun: false })
    expect(result.items.some((i) => i.storyId === id)).toBe(true)

    const [row] = await db.select().from(stories).where(eq(stories.storyId, id))
    expect(row?.status).toBe('cancelled')
  })

  it('cancels a story with title "test"', async () => {
    const epicId = await insertEpic()
    const id = await insertStory(epicId, 'test')

    const result = await svc.cleanFixtureStories({ dryRun: false })
    expect(result.items.some((i) => i.storyId === id)).toBe(true)

    const [row] = await db.select().from(stories).where(eq(stories.storyId, id))
    expect(row?.status).toBe('cancelled')
  })

  it('does NOT cancel a real story with a long title', async () => {
    const epicId = await insertEpic()
    const id = await insertStory(epicId, 'A real production story title')

    const result = await svc.cleanFixtureStories({ dryRun: false })
    expect(result.items.some((i) => i.storyId === id)).toBe(false)

    const [row] = await db.select().from(stories).where(eq(stories.storyId, id))
    expect(row?.status).toBe('backlog')
  })

  it('is idempotent — already-cancelled rows are not re-reported', async () => {
    const epicId = await insertEpic()
    // Insert already-cancelled fixture story
    const id = await insertStory(epicId, 's', 'cancelled')

    const result = await svc.cleanFixtureStories({ dryRun: false })
    // The already-cancelled story should NOT appear in items (it was excluded)
    expect(result.items.some((i) => i.storyId === id)).toBe(false)
  })

  it('dryRun=true does not commit changes', async () => {
    const epicId = await insertEpic()
    const id = await insertStory(epicId, 's')

    const result = await svc.cleanFixtureStories({ dryRun: true })
    expect(result.archived).toBe(0)
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    expect(result.items.some((i) => i.storyId === id)).toBe(true)

    // DB row unchanged
    const [row] = await db.select().from(stories).where(eq(stories.storyId, id))
    expect(row?.status).toBe('backlog')
  })
})

// ---------------------------------------------------------------------------
// cleanFixtureSprints
// ---------------------------------------------------------------------------

describe('HygieneService.cleanFixtureSprints', () => {
  it('completes a sprint with single-char name', async () => {
    const id = await insertSprint('A', 'active')

    const result = await svc.cleanFixtureSprints({ dryRun: false })
    expect(result.items.some((i) => i.sprintId === id)).toBe(true)

    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, id))
    expect(row?.status).toBe('completed')
    expect(row?.completedAt).toBeTruthy()
  })

  it('completes a sprint with [DEMO] prefix', async () => {
    const id = await insertSprint('[DEMO] Test sprint', 'planning')

    const result = await svc.cleanFixtureSprints({ dryRun: false })
    expect(result.items.some((i) => i.sprintId === id)).toBe(true)

    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, id))
    expect(row?.status).toBe('completed')
  })

  it('does NOT touch a real sprint with a normal name', async () => {
    const id = await insertSprint('Sprint 12 — Production', 'active')

    const result = await svc.cleanFixtureSprints({ dryRun: false })
    expect(result.items.some((i) => i.sprintId === id)).toBe(false)

    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, id))
    expect(row?.status).toBe('active')
  })

  it('is idempotent — already-completed fixture sprints are skipped', async () => {
    const id = await insertSprint('A', 'completed')

    const result = await svc.cleanFixtureSprints({ dryRun: false })
    expect(result.items.some((i) => i.sprintId === id)).toBe(false)
  })

  it('dryRun=true does not commit changes', async () => {
    const id = await insertSprint('B', 'active')

    const result = await svc.cleanFixtureSprints({ dryRun: true })
    expect(result.archived).toBe(0)
    expect(result.items.some((i) => i.sprintId === id)).toBe(true)

    const [row] = await db.select().from(sprints).where(eq(sprints.sprintId, id))
    expect(row?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// cleanStaleEscalations
// ---------------------------------------------------------------------------

describe('HygieneService.cleanStaleEscalations', () => {
  it('acknowledges open escalations when olderThanDays=0', async () => {
    const id = await insertEscalation('open', 0)

    const result = await svc.cleanStaleEscalations({ olderThanDays: 0, dryRun: false })
    expect(result.acknowledged).toBeGreaterThanOrEqual(1)
    expect(result.items.some((i) => i.escalationId === id)).toBe(true)

    const [row] = await db.select().from(escalations).where(eq(escalations.escalationId, id))
    expect(row?.state).toBe('acknowledged')
    expect(row?.resolutionNote).toBe('hygiene_sweep')
  })

  it('acknowledges open escalations older than N days', async () => {
    const oldId = await insertEscalation('open', 35)
    const recentId = await insertEscalation('open', 5)

    const result = await svc.cleanStaleEscalations({ olderThanDays: 30, dryRun: false })
    expect(result.items.some((i) => i.escalationId === oldId)).toBe(true)
    expect(result.items.some((i) => i.escalationId === recentId)).toBe(false)

    const [oldRow] = await db
      .select()
      .from(escalations)
      .where(eq(escalations.escalationId, oldId))
    expect(oldRow?.state).toBe('acknowledged')

    const [recentRow] = await db
      .select()
      .from(escalations)
      .where(eq(escalations.escalationId, recentId))
    expect(recentRow?.state).toBe('open')
  })

  it('is idempotent — already-acknowledged escalations are not re-reported', async () => {
    const id = await insertEscalation('acknowledged', 0)

    const result = await svc.cleanStaleEscalations({ olderThanDays: 0, dryRun: false })
    expect(result.items.some((i) => i.escalationId === id)).toBe(false)
  })

  it('dryRun=true does not commit changes', async () => {
    const id = await insertEscalation('open', 0)

    const result = await svc.cleanStaleEscalations({ olderThanDays: 0, dryRun: true })
    expect(result.acknowledged).toBe(0)
    expect(result.items.some((i) => i.escalationId === id)).toBe(true)

    const [row] = await db.select().from(escalations).where(eq(escalations.escalationId, id))
    expect(row?.state).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// runFullSweep
// ---------------------------------------------------------------------------

describe('HygieneService.runFullSweep', () => {
  it('runs all three cleanup methods and aggregates results', async () => {
    const epicId = await insertEpic()
    const storyId = await insertStory(epicId, 's')
    const sprintId = await insertSprint('Z', 'active')
    const escalationId = await insertEscalation('open', 0)

    const result = await svc.runFullSweep({ dryRun: false, olderThanDays: 0 })

    expect(result.dryRun).toBe(false)
    expect(result.stories.archived).toBeGreaterThanOrEqual(1)
    expect(result.sprints.archived).toBeGreaterThanOrEqual(1)
    expect(result.escalations.acknowledged).toBeGreaterThanOrEqual(1)

    expect(result.stories.items.some((i) => i.storyId === storyId)).toBe(true)
    expect(result.sprints.items.some((i) => i.sprintId === sprintId)).toBe(true)
    expect(result.escalations.items.some((i) => i.escalationId === escalationId)).toBe(true)
  })

  it('dryRun=true returns items but archived=0 for all', async () => {
    const epicId = await insertEpic()
    await insertStory(epicId, 's')
    await insertSprint('Z', 'active')
    await insertEscalation('open', 0)

    const result = await svc.runFullSweep({ dryRun: true, olderThanDays: 0 })

    expect(result.dryRun).toBe(true)
    expect(result.stories.archived).toBe(0)
    expect(result.sprints.archived).toBe(0)
    expect(result.escalations.acknowledged).toBe(0)
    // Items are still returned (SELECT happened)
    expect(result.stories.items.length).toBeGreaterThanOrEqual(1)
  })
})
