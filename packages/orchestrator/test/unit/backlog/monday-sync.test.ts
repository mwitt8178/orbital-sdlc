/**
 * Unit tests for MondaySyncService.
 *
 * The Monday HTTP layer is mocked at the network boundary using a custom
 * fetchImpl injected into DefaultMondayClient. No service-level mocking; the
 * Monday client's GraphQL pipeline is exercised end-to-end except for the
 * actual outbound HTTP call.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultMondayClient } from '../../../src/backlog/monday-client.js'
import { DefaultMondaySyncService } from '../../../src/backlog/monday-sync.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { stories, mondaySyncState, epics, storyAcceptanceCriteria } from '../../../src/db/schema/backlog.js'
import { events } from '../../../src/db/schema/events.js'

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
  ownedEpicIds.length = 0
  ownedStoryIds.length = 0
})

afterAll(async () => {
  if (ownedStoryIds.length > 0) {
    await db
      .delete(mondaySyncState)
      .where(inArray(mondaySyncState.aggregateId, ownedStoryIds))
    await db.delete(storyAcceptanceCriteria).where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds))
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds))
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds))
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// fetchImpl mock helper — captures calls and returns canned responses
// ---------------------------------------------------------------------------

interface MockResponseSpec {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function makeFetch(responses: MockResponseSpec[]): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
  let index = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const rawBody = init?.body
    let parsedBody: unknown = null
    if (typeof rawBody === 'string') {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }
    calls.push({
      url,
      body: parsedBody,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const spec = responses[Math.min(index, responses.length - 1)]
    index++
    return new Response(JSON.stringify(spec?.body ?? {}), {
      status: spec?.status ?? 200,
      headers: spec?.headers ?? { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }
  return { fetchImpl, calls }
}

async function makeStory(): Promise<{
  storyId: string
  story: typeof stories.$inferSelect
}> {
  const eventStore = createEventStore(db, sql)
  const backlog = new DefaultBacklogService(db, eventStore)
  const epic = await backlog.createEpic({
    vision_version_id: uuidv7(),
    title: 'monday-test',
    rationale: 'r',
    priority: 1,
  })
  ownedEpicIds.push(epic.epicId)
  const story = await backlog.createStory({
    epic_id: epic.epicId,
    title: 'Sync me',
    description: 'd',
    acceptance_criteria: [{ text: 'AC1' }],
  })
  ownedStoryIds.push(story.storyId)
  return { storyId: story.storyId, story }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultMondayClient — token resolution', () => {
  it('throws STARTUP_ERROR if no token is available', async () => {
    const original = process.env['MONDAY_API_TOKEN']
    delete process.env['MONDAY_API_TOKEN']
    process.env.ORBITAL_TEST_KEYCHAIN = '1'
    try {
      const client = new DefaultMondayClient({ fetchImpl: async () => new Response('') })
      await expect(client.getItem('1')).rejects.toMatchObject({ code: 'STARTUP_ERROR' })
    } finally {
      if (original !== undefined) process.env['MONDAY_API_TOKEN'] = original
    }
  })

  it('uses explicit token when provided', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { data: { items: [{ id: '1', name: 'X', column_values: [] }] } } },
    ])
    const client = new DefaultMondayClient({ token: 'tok-abc', fetchImpl })
    await client.getItem('1')
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer tok-abc' })
  })
})

describe('DefaultMondayClient — error handling', () => {
  it('throws INTEGRATION_MONDAY_AUTH on 401', async () => {
    const { fetchImpl } = makeFetch([{ status: 401, body: { error: 'auth' } }])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    await expect(client.getItem('1')).rejects.toMatchObject({ code: 'INTEGRATION_MONDAY_AUTH' })
  })

  it('retries on 429 and surfaces RATE_LIMIT_MONDAY_API after exhaustion', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
    ])
    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl,
      maxRetries: 1,
      sleepFn: async () => undefined,
    })
    await expect(client.getItem('1')).rejects.toMatchObject({ code: 'RATE_LIMIT_MONDAY_API' })
    expect(calls.length).toBe(2)
  })

  it('throws INTEGRATION_MONDAY_DOWN on 5xx after retries', async () => {
    const { fetchImpl } = makeFetch([
      { status: 503 },
      { status: 503 },
    ])
    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl,
      maxRetries: 1,
      sleepFn: async () => undefined,
    })
    await expect(client.getItem('1')).rejects.toMatchObject({ code: 'INTEGRATION_MONDAY_DOWN' })
  })

  it('throws INTEGRATION_MONDAY_DOWN on GraphQL errors in 200 body', async () => {
    const { fetchImpl } = makeFetch([
      { status: 200, body: { errors: [{ message: 'bad query' }] } },
    ])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    await expect(client.getItem('1')).rejects.toMatchObject({ code: 'INTEGRATION_MONDAY_DOWN' })
  })

  it('retries on network failure and eventually surfaces INTEGRATION_MONDAY_DOWN', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      throw new Error('network down')
    }
    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl,
      maxRetries: 1,
      sleepFn: async () => undefined,
    })
    await expect(client.getItem('1')).rejects.toMatchObject({ code: 'INTEGRATION_MONDAY_DOWN' })
    expect(calls).toBe(2)
  })
})

describe('DefaultMondayClient — GraphQL shape', () => {
  it('createSubitem sends a create_subitem mutation', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { data: { create_subitem: { id: 'sub-1' } } } },
    ])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    const result = await client.createSubitem({
      parentItemId: 'parent-1',
      itemName: 'Story X',
      columnValues: { status: 'backlog' },
    })
    expect(result.id).toBe('sub-1')
    const callBody = calls[0]?.body as { query: string; variables: unknown }
    expect(callBody.query).toMatch(/create_subitem/)
    expect((callBody.variables as { itemName: string }).itemName).toBe('Story X')
  })

  it('updateColumnValue sends a change_column_value mutation', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { data: { change_column_value: { id: 'item-1' } } } },
    ])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    await client.updateColumnValue({
      boardId: 'b1',
      itemId: 'item-1',
      columnId: 'status',
      value: '{"label":"done"}',
    })
    const callBody = calls[0]?.body as { query: string }
    expect(callBody.query).toMatch(/change_column_value/)
  })
})

describe('MondaySyncService.onStoryCreated', () => {
  it('creates a Monday subitem, persists state, emits MondaySyncCompleted', async () => {
    const { storyId, story } = await makeStory()
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { data: { create_subitem: { id: 'monday-123' } } } },
    ])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    const eventStore = createEventStore(db, sql)
    const sync = new DefaultMondaySyncService(db, eventStore, client)

    const result = await sync.onStoryCreated(story, 'parent-epic-1')
    expect(result.mondaySubitemId).toBe('monday-123')
    expect(calls.length).toBe(1)

    // Local story has monday_item_id populated
    const after = await db.select().from(stories).where(eq(stories.storyId, storyId))
    expect(after[0]?.mondayItemId).toBe('monday-123')

    // Sync state row created
    const stateRows = await db
      .select()
      .from(mondaySyncState)
      .where(eq(mondaySyncState.aggregateId, storyId))
    expect(stateRows.length).toBe(1)
    expect(stateRows[0]?.mondayId).toBe('monday-123')
    expect(stateRows[0]?.lastSeenItemIds).toContain('monday-123')

    // MondaySyncCompleted event written
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, storyId))
    expect(evRows.some((r) => r.eventType === 'MondaySyncCompleted')).toBe(true)
  })
})

describe('MondaySyncService.handleWebhookPayload', () => {
  it('echoes a challenge', async () => {
    const eventStore = createEventStore(db, sql)
    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl: async () => new Response('{}'),
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client)
    const result = await sync.handleWebhookPayload({ challenge: 'abc' })
    expect(result.accepted).toBe(true)
    expect(result.reason).toBe('challenge')
  })

  it('applies a status change from update_column_value events', async () => {
    const { storyId, story } = await makeStory()
    // Pre-attach a monday_item_id
    await db
      .update(stories)
      .set({ mondayItemId: 'monday-321' })
      .where(eq(stories.storyId, story.storyId))

    const eventStore = createEventStore(db, sql)
    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl: async () => new Response('{}'),
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client)
    await sync.handleWebhookPayload({
      event: {
        type: 'update_column_value',
        boardId: 'b',
        pulseId: 'monday-321',
        columnId: 'status',
        value: { label: { text: 'ready' } },
      },
    })

    const after = await db.select().from(stories).where(eq(stories.storyId, storyId))
    expect(after[0]?.status).toBe('ready')
  })
})
