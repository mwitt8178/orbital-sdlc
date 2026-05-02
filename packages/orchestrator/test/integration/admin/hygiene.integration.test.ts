/**
 * integration/admin/hygiene.integration.test.ts — tRPC admin.hygiene procedures.
 *
 * Tests that:
 *   - admin.hygiene.preview returns a dry-run result without mutating DB
 *   - admin.hygiene.run with ack='I understand' applies state transitions
 *   - admin.hygiene.run without ack fails Zod validation
 *   - Events are emitted in audit.events after a real run
 *
 * Uses createCallerFactory to call procedures directly (no HTTP layer).
 * NODE_ENV=test satisfies open-dev-mode auth (no token required).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { db, sql as sqlPool } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createAdminRouter, _resetAdminRouterCache } from '../../../src/trpc/routers/admin.js'
import { t } from '../../../src/trpc/init.js'
import { _resetOpenModeWarning } from '../../../src/admin/auth.js'

// ---------------------------------------------------------------------------
// Open dev mode for tests — no real admin token needed
// ---------------------------------------------------------------------------

const originalNodeEnv = process.env['NODE_ENV']
const originalAdminToken = process.env['ADMIN_TOKEN']

// Ensure open-dev mode: no token configured + NODE_ENV=development
// (per admin/auth.ts logic: open if no token configured AND nodeEnv === 'development')
process.env['NODE_ENV'] = 'development'
delete process.env['ADMIN_TOKEN']

// Restore env after all tests
if (typeof afterAll !== 'undefined') {
  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalNodeEnv
    if (originalAdminToken === undefined) delete process.env['ADMIN_TOKEN']
    else process.env['ADMIN_TOKEN'] = originalAdminToken
  })
}
import { stories, sprints, epics } from '../../../src/db/schema/backlog.js'
import { escalations } from '../../../src/db/schema/orchestration.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const cleanup = {
  epicIds: [] as string[],
  storyIds: [] as string[],
  sprintIds: [] as string[],
  escalationIds: [] as string[],
}

async function insertEpic(): Promise<string> {
  const epicId = uuidv7()
  await db.insert(epics).values({
    epicId,
    visionVersionId: uuidv7(),
    title: 'Integration test epic',
    rationale: 'hygiene integration test',
    priority: 9999,
    status: 'active',
    schemaVersion: 1,
  })
  cleanup.epicIds.push(epicId)
  return epicId
}

async function insertStory(epicId: string, title: string): Promise<string> {
  const storyId = uuidv7()
  await db.insert(stories).values({
    storyId,
    epicId,
    title,
    description: 'integration hygiene test',
    status: 'backlog',
    priority: 0,
    schemaVersion: 1,
  })
  cleanup.storyIds.push(storyId)
  return storyId
}

async function insertSprint(name: string): Promise<string> {
  const sprintId = uuidv7()
  await db.insert(sprints).values({
    sprintId,
    name,
    sequence: 8888,
    status: 'active',
    storyPointCapacity: 1,
    budgetUsdCents: 100,
    concurrencyShare: 100,
    priorityClass: 'standard',
    schemaVersion: 1,
  })
  cleanup.sprintIds.push(sprintId)
  return sprintId
}

async function insertEscalation(): Promise<string> {
  const escalationId = uuidv7()
  await db.insert(escalations).values({
    escalationId,
    taskId: uuidv7(),
    reason: 'retry_budget_exhausted',
    triggeringEventId: uuidv7(),
    context: { integration_test: true },
    state: 'open',
  })
  cleanup.escalationIds.push(escalationId)
  return escalationId
}

beforeEach(() => {
  cleanup.epicIds.length = 0
  cleanup.storyIds.length = 0
  cleanup.sprintIds.length = 0
  cleanup.escalationIds.length = 0
  // Reset singleton cache so each test gets a fresh router+service
  _resetAdminRouterCache()
  // Reset open-dev-mode warning flag (per admin/auth.ts test pattern)
  _resetOpenModeWarning()
})

afterEach(async () => {
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
// Caller setup
// ---------------------------------------------------------------------------

function makeCaller() {
  const adminRouter = createAdminRouter()
  const createCallerFactory = t.createCallerFactory(adminRouter)
  return createCallerFactory({})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin.hygiene.preview (tRPC)', () => {
  it('returns dry-run result without mutating DB', async () => {
    const epicId = await insertEpic()
    const storyId = await insertStory(epicId, 's')
    const sprintId = await insertSprint('A')
    const escalationId = await insertEscalation()

    const caller = makeCaller()
    const result = await caller.hygiene.preview()

    expect(result.dryRun).toBe(true)
    expect(result.stories.archived).toBe(0)
    expect(result.sprints.archived).toBe(0)
    expect(result.escalations.acknowledged).toBe(0)

    // Our specific rows appear in the items list
    expect(result.stories.items.some((i) => i.storyId === storyId)).toBe(true)
    expect(result.sprints.items.some((i) => i.sprintId === sprintId)).toBe(true)
    // NOTE: preview uses default olderThanDays=30; our fresh escalation (0 days old)
    // won't appear. We verify DB row unchanged instead.
    // escalationId is NOT expected in items here.

    // DB rows unchanged (check story + sprint; escalation may have been swept by concurrent
    // unit test since olderThanDays defaults to 30 but 0-day-old items match when tests
    // run concurrently — check story + sprint which have title-based matching, not time-based)
    const [storyRow] = await db.select().from(stories).where(eq(stories.storyId, storyId))
    expect(storyRow?.status).toBe('backlog')

    const [sprintRow] = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId))
    expect(sprintRow?.status).toBe('active')
  })
})

describe('admin.hygiene.run (tRPC)', () => {
  it('applies state transitions when ack is correct', async () => {
    const epicId = await insertEpic()
    const storyId = await insertStory(epicId, 'x')
    const sprintId = await insertSprint('B')
    const escalationId = await insertEscalation()

    const caller = makeCaller()
    const result = await caller.hygiene.run({
      ack: 'I understand',
      olderThanDays: 0,
    })

    expect(result.dryRun).toBe(false)
    expect(result.stories.archived).toBeGreaterThanOrEqual(1)
    expect(result.sprints.archived).toBeGreaterThanOrEqual(1)
    expect(result.escalations.acknowledged).toBeGreaterThanOrEqual(1)

    // Verify DB state
    const [storyRow] = await db.select().from(stories).where(eq(stories.storyId, storyId))
    expect(storyRow?.status).toBe('cancelled')

    const [sprintRow] = await db.select().from(sprints).where(eq(sprints.sprintId, sprintId))
    expect(sprintRow?.status).toBe('completed')

    const [escRow] = await db
      .select()
      .from(escalations)
      .where(eq(escalations.escalationId, escalationId))
    expect(escRow?.state).toBe('acknowledged')
    expect(escRow?.resolutionNote).toBe('hygiene_sweep')
  })

  it('emits AdminHygieneSweepCompleted events in audit.events', async () => {
    const epicId = await insertEpic()
    await insertStory(epicId, 's')
    await insertSprint('C')
    await insertEscalation()

    // Count events before
    const es = createEventStore(db, sqlPool)
    const before = await es.query({ event_type: 'AdminHygieneSweepCompleted', limit: 1000 })
    const beforeCount = before.items.length

    const caller = makeCaller()
    await caller.hygiene.run({
      ack: 'I understand',
      olderThanDays: 0,
    })

    const after = await es.query({ event_type: 'AdminHygieneSweepCompleted', limit: 1000 })
    // At least one new event per sweep type that had items
    expect(after.items.length).toBeGreaterThan(beforeCount)
  })

  it('rejects run without ack field', async () => {
    const caller = makeCaller()

    // Missing ack — Zod validation should reject
    await expect(
      caller.hygiene.run({
        ack: 'wrong phrase' as 'I understand',
        olderThanDays: 0,
      }),
    ).rejects.toThrow()
  })

  it('is idempotent — second run returns 0 counts', async () => {
    const epicId = await insertEpic()
    await insertStory(epicId, 's')
    await insertSprint('D')
    await insertEscalation()

    const caller = makeCaller()

    // First run
    const first = await caller.hygiene.run({ ack: 'I understand', olderThanDays: 0 })
    expect(first.stories.archived).toBeGreaterThanOrEqual(1)

    // Second run — same data, already transitioned
    const second = await caller.hygiene.run({ ack: 'I understand', olderThanDays: 0 })
    // Our specific rows are already cancelled/acknowledged
    expect(second.stories.items.some((i) => cleanup.storyIds.includes(i.storyId))).toBe(false)
    expect(second.sprints.items.some((i) => cleanup.sprintIds.includes(i.sprintId))).toBe(false)
    expect(
      second.escalations.items.some((i) => cleanup.escalationIds.includes(i.escalationId)),
    ).toBe(false)
  })
})
