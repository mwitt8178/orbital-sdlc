/**
 * Unit tests for BacklogService against real Postgres.
 *
 * Per Phase 4B brief: integration-style tests for service.ts validating epic /
 * story CRUD, AC management, prioritization, estimation, groom, and FR-2.6
 * linked-artifact enforcement at the validation layer.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { epics, stories, storyAcceptanceCriteria } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'
import { isValidStoryTransition } from '../../../src/backlog/types.js'

let backlog: DefaultBacklogService
const ownedEpicIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  backlog = new DefaultBacklogService(db, eventStore)
})

beforeEach(() => {
  ownedEpicIds.length = 0
})

afterAll(async () => {
  // Clean up our created epics + stories + ACs created in this test file.
  if (ownedEpicIds.length > 0) {
    const sIds = await db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(inArray(stories.epicId, ownedEpicIds))
    const storyIds = sIds.map((r) => r.storyId)
    if (storyIds.length > 0) {
      await db
        .delete(storyAcceptanceCriteria)
        .where(inArray(storyAcceptanceCriteria.storyId, storyIds))
      await db.delete(stories).where(inArray(stories.epicId, ownedEpicIds))
    }
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

async function makeEpic(): Promise<string> {
  const e = await backlog.createEpic({
    vision_version_id: uuidv7(),
    title: 'unit-epic',
    rationale: 'rationale',
    priority: 100,
  })
  ownedEpicIds.push(e.epicId)
  return e.epicId
}

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe('isValidStoryTransition (state machine)', () => {
  it('allows backlog -> ready', () => {
    expect(isValidStoryTransition('backlog', 'ready')).toBe(true)
  })
  it('rejects backlog -> done', () => {
    expect(isValidStoryTransition('backlog', 'done')).toBe(false)
  })
  it('allows in_review -> done', () => {
    expect(isValidStoryTransition('in_review', 'done')).toBe(true)
  })
  it('allows done -> accepted and done -> defective', () => {
    expect(isValidStoryTransition('done', 'accepted')).toBe(true)
    expect(isValidStoryTransition('done', 'defective')).toBe(true)
  })
  it('treats accepted as terminal', () => {
    expect(isValidStoryTransition('accepted', 'backlog')).toBe(false)
    expect(isValidStoryTransition('accepted', 'done')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Epic + Story CRUD
// ---------------------------------------------------------------------------

describe('BacklogService.createEpic', () => {
  it('inserts an epic and emits EpicCreated', async () => {
    const visionVersionId = uuidv7()
    const epic = await backlog.createEpic({
      vision_version_id: visionVersionId,
      title: 'Epic A',
      rationale: 'because',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    expect(epic.title).toBe('Epic A')
    expect(epic.priority).toBe(1)
    expect(epic.status).toBe('draft')

    // Verify event was appended
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, epic.epicId))
    expect(evRows.some((r) => r.eventType === 'EpicCreated')).toBe(true)
  })
})

describe('BacklogService.createStory', () => {
  it('inserts a story with ACs and emits StoryCreated', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 'Login flow',
      description: 'User can log in',
      acceptance_criteria: [
        { text: 'Given valid creds, login succeeds' },
        { text: 'Given invalid creds, returns 401' },
      ],
    })
    expect(story.title).toBe('Login flow')
    expect(story.acceptanceCriteria.length).toBe(2)
    expect(story.acceptanceCriteria[0]?.ordinal).toBe(1)
    expect(story.acceptanceCriteria[1]?.ordinal).toBe(2)
    expect(story.status).toBe('backlog')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, story.storyId))
    expect(evRows.some((r) => r.eventType === 'StoryCreated')).toBe(true)
  })

  it('rejects story with empty acceptance_criteria', async () => {
    const epicId = await makeEpic()
    await expect(
      backlog.createStory({
        epic_id: epicId,
        title: 'No ACs',
        description: 'd',
        acceptance_criteria: [],
      }),
    ).rejects.toThrow()
  })

  it('rejects story whose epic does not exist', async () => {
    await expect(
      backlog.createStory({
        epic_id: uuidv7(),
        title: 'orphan',
        description: 'd',
        acceptance_criteria: [{ text: 'AC' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND_EPIC' })
  })
})

// ---------------------------------------------------------------------------
// Status transitions + linked-artifact enforcement (FR-2.6)
// ---------------------------------------------------------------------------

describe('BacklogService.updateStory — status transitions + FR-2.6', () => {
  it('promotes backlog -> ready and emits StoryStatusChanged', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC1' }],
    })
    const updated = await backlog.updateStory({
      story_id: story.storyId,
      status: 'ready',
      reason: 'groomed',
    })
    expect(updated.status).toBe('ready')

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, story.storyId))
    expect(evRows.some((r) => r.eventType === 'StoryStatusChanged')).toBe(true)
  })

  it('rejects in_review -> done without linked_artifacts (FR-2.6)', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC1' }],
    })
    // Force-progress: backlog -> ready -> in_progress -> in_review -> done attempt
    await backlog.updateStory({ story_id: story.storyId, status: 'ready', reason: 'r' })
    await backlog.updateStory({ story_id: story.storyId, status: 'in_progress', reason: 'r' })
    await backlog.updateStory({ story_id: story.storyId, status: 'in_review', reason: 'r' })

    await expect(
      backlog.updateStory({
        story_id: story.storyId,
        status: 'done',
        reason: 'r',
        linked_artifacts: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_LINKED_ARTIFACT_MISSING' })
  })

  it('accepts in_review -> done with a pr linked_artifact', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC1' }],
    })
    await backlog.updateStory({ story_id: story.storyId, status: 'ready', reason: 'r' })
    await backlog.updateStory({ story_id: story.storyId, status: 'in_progress', reason: 'r' })
    await backlog.updateStory({ story_id: story.storyId, status: 'in_review', reason: 'r' })
    const result = await backlog.updateStory({
      story_id: story.storyId,
      status: 'done',
      reason: 'r',
      linked_artifacts: [{ type: 'pr', id: 'PR-123' }],
    })
    expect(result.status).toBe('done')
  })

  it('rejects illegal transition backlog -> done', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC1' }],
    })
    await expect(
      backlog.updateStory({ story_id: story.storyId, status: 'done', reason: 'r' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION' })
  })
})

// ---------------------------------------------------------------------------
// Prioritization
// ---------------------------------------------------------------------------

describe('BacklogService.movStoryToPosition', () => {
  it('moves a story up and emits BacklogReprioritized', async () => {
    const epicId = await makeEpic()
    const a = await backlog.createStory({
      epic_id: epicId,
      title: 'a',
      description: 'd',
      acceptance_criteria: [{ text: 'A' }],
    })
    const b = await backlog.createStory({
      epic_id: epicId,
      title: 'b',
      description: 'd',
      acceptance_criteria: [{ text: 'A' }],
    })
    const c = await backlog.createStory({
      epic_id: epicId,
      title: 'c',
      description: 'd',
      acceptance_criteria: [{ text: 'A' }],
    })

    expect(a.priority).toBe(0)
    expect(b.priority).toBe(1)
    expect(c.priority).toBe(2)

    // Move c to position 0
    await backlog.movStoryToPosition(c.storyId, 0)

    const after = await backlog.listStories({ epicId })
    const map = Object.fromEntries(after.map((s) => [s.storyId, s.priority]))
    expect(map[c.storyId]).toBe(0)
    expect(map[a.storyId]).toBe(1)
    expect(map[b.storyId]).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

describe('BacklogService.estimateStory', () => {
  it('writes story_points + emits StoryEstimated', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    const updated = await backlog.estimateStory(story.storyId, 5, 'medium complexity')
    expect(updated.storyPoints).toBe(5)

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, story.storyId))
    expect(evRows.some((r) => r.eventType === 'StoryEstimated')).toBe(true)
  })

  it('rejects non-positive points', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    await expect(backlog.estimateStory(story.storyId, 0, 'why')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Groom (refine + estimate aggregate)
// ---------------------------------------------------------------------------

describe('BacklogService.groom', () => {
  it('adds and removes ACs and emits StoryRefined', async () => {
    const epicId = await makeEpic()
    const story = await backlog.createStory({
      epic_id: epicId,
      title: 's',
      description: 'd',
      acceptance_criteria: [{ text: 'AC1' }, { text: 'AC2' }],
    })
    const ac1 = story.acceptanceCriteria[0]!
    const result = await backlog.groom({
      storyId: story.storyId,
      addAcs: ['AC3'],
      removeAcIds: [ac1.acId],
      storyPoints: 3,
      rationale: 'groomed in ceremony',
    })
    const acTexts = result.acceptanceCriteria.map((a) => a.text).sort()
    expect(acTexts).toContain('AC2')
    expect(acTexts).toContain('AC3')
    expect(acTexts).not.toContain('AC1')
    expect(result.storyPoints).toBe(3)

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, story.storyId))
    expect(evRows.some((r) => r.eventType === 'StoryRefined')).toBe(true)
    expect(evRows.some((r) => r.eventType === 'StoryEstimated')).toBe(true)
  })
})
