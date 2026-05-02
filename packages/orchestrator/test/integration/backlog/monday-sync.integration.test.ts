/**
 * Integration test for the Monday sync flow.
 *
 * Real Postgres. Real BacklogService, MondaySyncService, MondayClient. The
 * Monday HTTP layer is mocked at the network boundary using undici MockAgent
 * + setGlobalDispatcher. The MondayClient uses globalThis.fetch which routes
 * through the mock.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, fetch as undiciFetch } from 'undici'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { DefaultMondayClient } from '../../../src/backlog/monday-client.js'
import { DefaultMondaySyncService } from '../../../src/backlog/monday-sync.js'
import {
  epics,
  stories,
  storyAcceptanceCriteria,
  mondaySyncState,
} from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

// ---------------------------------------------------------------------------
// Tracked rows for cleanup
// ---------------------------------------------------------------------------

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []

let originalDispatcher: ReturnType<typeof getGlobalDispatcher>
let mockAgent: MockAgent

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
  // Snapshot whatever dispatcher was active before the test
  originalDispatcher = getGlobalDispatcher()
  mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)
})

afterEach(async () => {
  await mockAgent.close()
  setGlobalDispatcher(originalDispatcher)
})

afterAll(async () => {
  if (ownedStoryIds.length > 0) {
    await db
      .delete(mondaySyncState)
      .where(inArray(mondaySyncState.aggregateId, ownedStoryIds))
    await db
      .delete(storyAcceptanceCriteria)
      .where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds))
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds))
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monday sync — story-created push (HTTP boundary mocked)', () => {
  it('issues a real GraphQL POST to api.monday.com/v2 and persists state', async () => {
    const eventStore = createEventStore(db, sql)
    const backlog = new DefaultBacklogService(db, eventStore)

    const epic = await backlog.createEpic({
      vision_version_id: uuidv7(),
      title: 'Integration epic',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    const story = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'Sync me 1',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story.storyId)

    // Set up the HTTP mock at the boundary.
    const pool = mockAgent.get('https://api.monday.com')
    let receivedBody: { query: string; variables: Record<string, unknown> } | null = null
    pool
      .intercept({ path: '/v2', method: 'POST' })
      .reply((opts) => {
        const raw = opts.body
        if (typeof raw === 'string') {
          receivedBody = JSON.parse(raw) as typeof receivedBody
        }
        return {
          statusCode: 200,
          data: JSON.stringify({ data: { create_subitem: { id: 'monday-int-42' } } }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        }
      })

    const client = new DefaultMondayClient({
      token: 'integ-token',
      fetchImpl: undiciFetch as unknown as typeof fetch,
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client)

    const result = await sync.onStoryCreated(story, 'parent-epic-id')
    expect(result.mondaySubitemId).toBe('monday-int-42')

    // Verify the GraphQL mutation shape
    expect(receivedBody).not.toBeNull()
    const body = receivedBody as {
      query: string
      variables: { itemName?: string; parentItemId?: string }
    }
    expect(body.query).toMatch(/create_subitem/)
    expect(body.variables.itemName).toBe('Sync me 1')

    // Verify monday_sync_state row written
    const stateRows = await db
      .select()
      .from(mondaySyncState)
      .where(eq(mondaySyncState.aggregateId, story.storyId))
    expect(stateRows.length).toBe(1)
    expect(stateRows[0]?.mondayId).toBe('monday-int-42')

    // Verify MondaySyncCompleted event written
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, story.storyId))
    expect(evRows.some((r) => r.eventType === 'MondaySyncCompleted')).toBe(true)
  }, 30_000)

  it('surfaces INTEGRATION_MONDAY_DOWN when Monday returns 5xx after retries', async () => {
    const eventStore = createEventStore(db, sql)
    const backlog = new DefaultBacklogService(db, eventStore)

    const epic = await backlog.createEpic({
      vision_version_id: uuidv7(),
      title: 'down-test',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    const story = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'down story',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story.storyId)

    const pool = mockAgent.get('https://api.monday.com')
    pool
      .intercept({ path: '/v2', method: 'POST' })
      .reply(503, '')
      .times(10)

    const client = new DefaultMondayClient({
      token: 't',
      maxRetries: 1,
      sleepFn: async () => undefined,
      fetchImpl: undiciFetch as unknown as typeof fetch,
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client)

    await expect(sync.onStoryCreated(story, 'parent')).rejects.toMatchObject({
      code: 'INTEGRATION_MONDAY_DOWN',
    })
  }, 30_000)
})
