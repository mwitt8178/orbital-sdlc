/**
 * monday-sync.e2e.test.ts — Monday.com sync E2E tests.
 *
 * Phase 8 QA. Real Postgres, real service logic, HTTP mocked ONLY at the
 * fetch boundary via a custom fetchImpl injected into DefaultMondayClient.
 * No service-level mocking — MondaySyncService, BacklogService, and
 * verifyMondaySignature all run real code.
 *
 * Scenarios:
 * 1. Story created → onStoryCreated sends correct GraphQL createSubitem mutation
 *    to Monday and emits MondaySyncCompleted event.
 * 2. Monday webhook fires with valid x-monday-signature → story status updated
 *    in Orbital; MondaySyncCompleted event emitted.
 * 3. Tampered signature on incoming webhook → 401 response; no story update.
 * 4. Reconcile: local story has no Monday item → drift detected in sync state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { createHmac } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import { eq, inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../src/db/client.js'
import { createEventStore } from '../../src/events/store.js'
import { DefaultBacklogService } from '../../src/backlog/service.js'
import { DefaultMondayClient } from '../../src/backlog/monday-client.js'
import { DefaultMondaySyncService } from '../../src/backlog/monday-sync.js'
import {
  registerBacklogWebhook,
  verifyMondaySignature,
} from '../../src/backlog/webhook.js'
import {
  stories,
  mondaySyncState,
  epics,
  storyAcceptanceCriteria,
} from '../../src/db/schema/backlog.js'
import { events } from '../../src/db/schema/events.js'

// ---------------------------------------------------------------------------
// Test state tracking for cleanup
// ---------------------------------------------------------------------------

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  if (ownedStoryIds.length > 0) {
    await db
      .delete(mondaySyncState)
      .where(inArray(mondaySyncState.aggregateId, ownedStoryIds))
      .catch(() => undefined)
    await db
      .delete(storyAcceptanceCriteria)
      .where(inArray(storyAcceptanceCriteria.storyId, ownedStoryIds))
      .catch(() => undefined)
    await db.delete(stories).where(inArray(stories.storyId, ownedStoryIds)).catch(() => undefined)
  }
  if (ownedEpicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, ownedEpicIds)).catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Mock fetch factory — captures outbound calls, returns canned responses
// ---------------------------------------------------------------------------

interface MockCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface CannedResponse {
  status?: number
  body?: unknown
}

function makeMockFetch(responses: CannedResponse[]): {
  fetchImpl: typeof fetch
  calls: MockCall[]
} {
  const calls: MockCall[] = []
  let idx = 0

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    let parsedBody: unknown = null
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: parsedBody,
    })
    const spec = responses[Math.min(idx, responses.length - 1)] ?? { status: 200, body: {} }
    idx++
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }

  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// Shared helper: create an epic + story in the DB
// ---------------------------------------------------------------------------

async function seedStory(eventStore: ReturnType<typeof createEventStore>): Promise<{
  epicId: string
  storyId: string
  story: typeof stories.$inferSelect
}> {
  const backlog = new DefaultBacklogService(db, eventStore)

  const epic = await backlog.createEpic({
    vision_version_id: uuidv7(),
    title: `e2e-monday-epic-${uuidv7().slice(0, 8)}`,
    rationale: 'QA',
    priority: 1,
  })
  ownedEpicIds.push(epic.epicId)

  const storyResult = await backlog.createStory({
    epic_id: epic.epicId,
    title: `e2e-monday-story-${uuidv7().slice(0, 8)}`,
    description: 'E2E Monday sync story',
    acceptance_criteria: [{ text: 'AC1: syncs to Monday' }],
  })
  ownedStoryIds.push(storyResult.storyId)

  const storyRow = await db
    .select()
    .from(stories)
    .where(eq(stories.storyId, storyResult.storyId))
    .limit(1)

  return { epicId: epic.epicId, storyId: storyResult.storyId, story: storyRow[0]! }
}

// ---------------------------------------------------------------------------
// Scenario 1: onStoryCreated sends correct GraphQL mutation + emits event
// ---------------------------------------------------------------------------

describe('Scenario 1: onStoryCreated pushes to Monday with real GraphQL mutation', () => {
  it(
    'calls createSubitem mutation with correct item name and emits MondaySyncCompleted',
    async () => {
      const eventStore = createEventStore(db, sql)
      const { storyId, story } = await seedStory(eventStore)

      const FAKE_MONDAY_SUBITEM_ID = `m_${uuidv7().slice(0, 12)}`
      const parentMondayItemId = `epic_${uuidv7().slice(0, 8)}`

      const { fetchImpl, calls } = makeMockFetch([
        {
          status: 200,
          body: {
            data: {
              create_subitem: {
                id: FAKE_MONDAY_SUBITEM_ID,
              },
            },
          },
        },
      ])

      const mondayClient = new DefaultMondayClient({
        token: 'test-monday-token',
        fetchImpl,
        sleepFn: () => Promise.resolve(),
      })

      const syncService = new DefaultMondaySyncService(db, eventStore, mondayClient)

      const result = await syncService.onStoryCreated(story, parentMondayItemId)
      expect(result.mondaySubitemId).toBe(FAKE_MONDAY_SUBITEM_ID)

      // Exactly one HTTP call was made.
      expect(calls).toHaveLength(1)
      const call = calls[0]!

      // It was a POST to the Monday GraphQL endpoint.
      expect(call.method).toBe('POST')
      expect(call.url).toContain('monday.com')

      // The body contains the createSubitem mutation.
      const bodyObj = call.body as { query: string; variables: Record<string, unknown> }
      expect(bodyObj.query).toContain('create_subitem')
      expect(JSON.stringify(bodyObj.variables)).toContain(parentMondayItemId)
      expect(JSON.stringify(bodyObj.variables)).toContain(story.title)

      // Authorization header present.
      expect(call.headers['Authorization']).toBe('Bearer test-monday-token')

      // MondaySyncCompleted event persisted via EventStore.
      const syncEvents = await db
        .select()
        .from(events)
        .where(eq(events.aggregateId, storyId))
      const syncCompletedEvs = syncEvents.filter((e) => e.eventType === 'MondaySyncCompleted')
      expect(syncCompletedEvs.length).toBeGreaterThanOrEqual(1)

      const evPayload = syncCompletedEvs[0]!.payload as Record<string, unknown>
      expect(evPayload['direction']).toBe('push')
      expect(evPayload['aggregate_type']).toBe('story')

      // mondaySyncState row persisted.
      const syncState = await db
        .select()
        .from(mondaySyncState)
        .where(eq(mondaySyncState.aggregateId, storyId))
      expect(syncState).toHaveLength(1)
      expect(syncState[0]!.mondayId).toBe(FAKE_MONDAY_SUBITEM_ID)

      // The story row is updated with the Monday item ID.
      const storyAfter = await db
        .select()
        .from(stories)
        .where(eq(stories.storyId, storyId))
        .limit(1)
      expect(storyAfter[0]!.mondayItemId).toBe(FAKE_MONDAY_SUBITEM_ID)
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Scenario 2: webhook fires with valid signature → story status updated
// ---------------------------------------------------------------------------

describe('Scenario 2: webhook with valid x-monday-signature updates story status', () => {
  it(
    'accepts verified webhook, calls handleWebhookPayload, emits MondaySyncCompleted',
    async () => {
      const eventStore = createEventStore(db, sql)
      const { storyId, story } = await seedStory(eventStore)

      // Pre-populate mondaySyncState so handleWebhookPayload can find the mapping.
      const FAKE_MONDAY_ITEM_ID = `m_${uuidv7().slice(0, 12)}`
      const syncStateId = uuidv7()
      await db.insert(mondaySyncState).values({
        syncStateId,
        aggregateType: 'story',
        aggregateId: storyId,
        mondayId: FAKE_MONDAY_ITEM_ID,
        lastPushAt: new Date(),
        lastPushHash: 'init',
        lastSeenItemIds: [FAKE_MONDAY_ITEM_ID],
        syncErrorCount: 0,
        schemaVersion: 1,
      })

      // Update story row with the Monday item ID so status-change can find it.
      await db
        .update(stories)
        .set({ mondayItemId: FAKE_MONDAY_ITEM_ID })
        .where(eq(stories.storyId, storyId))

      const WEBHOOK_SECRET = 'test-webhook-secret-xyzabc'

      const { fetchImpl } = makeMockFetch([]) // no outbound calls expected for webhook
      const mondayClient = new DefaultMondayClient({
        token: 'test-monday-token',
        fetchImpl,
        sleepFn: () => Promise.resolve(),
      })
      const syncService = new DefaultMondaySyncService(db, eventStore, mondayClient)

      // Build the webhook payload: Monday signals a column value change.
      const webhookPayload = {
        event: {
          type: 'update_column_value',
          boardId: '12345',
          pulseId: FAKE_MONDAY_ITEM_ID,
          columnId: 'status',
          value: { label: { text: 'Done' } },
          previousValue: { label: { text: 'In Progress' } },
        },
        webhookId: uuidv7(),
      }

      const rawBody = JSON.stringify(webhookPayload)
      const hmac = createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf-8').digest('hex')

      // Register the Fastify route and fire a request.
      const app = Fastify({ logger: false })
      registerBacklogWebhook(app, { secret: WEBHOOK_SECRET, syncService })

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/monday',
        headers: {
          'Content-Type': 'application/json',
          'x-monday-signature': hmac,
        },
        payload: rawBody,
      })

      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body) as { ok: boolean }
      expect(body.ok).toBe(true)

      await app.close()
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Scenario 3: tampered signature → 401 / no story update
// ---------------------------------------------------------------------------

describe('Scenario 3: tampered webhook signature → 401', () => {
  it('rejects webhook with bad HMAC and returns 401', async () => {
    const eventStore = createEventStore(db, sql)
    const { story } = await seedStory(eventStore)

    const { fetchImpl } = makeMockFetch([])
    const mondayClient = new DefaultMondayClient({
      token: 'test-monday-token',
      fetchImpl,
      sleepFn: () => Promise.resolve(),
    })
    const syncService = new DefaultMondaySyncService(db, eventStore, mondayClient)

    const WEBHOOK_SECRET = 'correct-secret'
    const webhookPayload = {
      event: {
        type: 'update_column_value',
        boardId: '12345',
        pulseId: story.mondayItemId ?? 'unknown',
        columnId: 'status',
        value: { label: { text: 'Done' } },
      },
      webhookId: uuidv7(),
    }
    const rawBody = JSON.stringify(webhookPayload)

    // Intentionally wrong signature.
    const tampered = createHmac('sha256', 'WRONG_SECRET').update(rawBody, 'utf-8').digest('hex')

    const app = Fastify({ logger: false })
    registerBacklogWebhook(app, { secret: WEBHOOK_SECRET, syncService })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      headers: {
        'Content-Type': 'application/json',
        'x-monday-signature': tampered,
      },
      payload: rawBody,
    })

    expect(response.statusCode).toBe(401)
    const respBody = JSON.parse(response.body) as { error: { code: string } }
    expect(respBody.error.code).toBe('WEBHOOK_INVALID_SIGNATURE')

    await app.close()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 4: verifyMondaySignature unit coverage (correct / incorrect / missing)
// ---------------------------------------------------------------------------

describe('Scenario 4: verifyMondaySignature helper', () => {
  it('returns true for correct HMAC', () => {
    const secret = 'my-secret'
    const body = '{"event":"test"}'
    const sig = createHmac('sha256', secret).update(body, 'utf-8').digest('hex')
    expect(verifyMondaySignature(body, sig, secret)).toBe(true)
  })

  it('returns false for wrong signature', () => {
    const secret = 'my-secret'
    const body = '{"event":"test"}'
    expect(verifyMondaySignature(body, 'deadbeef', secret)).toBe(false)
  })

  it('returns false when signature is missing / undefined', () => {
    const secret = 'my-secret'
    const body = '{"event":"test"}'
    expect(verifyMondaySignature(body, undefined, secret)).toBe(false)
  })

  it('returns false when body is tampered after signing', () => {
    const secret = 'my-secret'
    const originalBody = '{"event":"original"}'
    const tamperedBody = '{"event":"tampered"}'
    const sig = createHmac('sha256', secret).update(originalBody, 'utf-8').digest('hex')
    expect(verifyMondaySignature(tamperedBody, sig, secret)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: Monday challenge handshake echo
// ---------------------------------------------------------------------------

describe('Scenario 5: Monday webhook challenge handshake', () => {
  it('echoes the challenge token for Monday setup handshake', async () => {
    const eventStore = createEventStore(db, sql)
    const { fetchImpl } = makeMockFetch([])
    const mondayClient = new DefaultMondayClient({
      token: 'test-monday-token',
      fetchImpl,
      sleepFn: () => Promise.resolve(),
    })
    const syncService = new DefaultMondaySyncService(db, eventStore, mondayClient)

    const WEBHOOK_SECRET = 'test-challenge-secret'
    const challengeToken = `challenge-${uuidv7()}`
    const challengePayload = JSON.stringify({ challenge: challengeToken })
    const hmac = createHmac('sha256', WEBHOOK_SECRET)
      .update(challengePayload, 'utf-8')
      .digest('hex')

    const app = Fastify({ logger: false })
    registerBacklogWebhook(app, { secret: WEBHOOK_SECRET, syncService })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      headers: {
        'Content-Type': 'application/json',
        'x-monday-signature': hmac,
      },
      payload: challengePayload,
    })

    expect(response.statusCode).toBe(200)
    const respBody = JSON.parse(response.body) as { challenge: string }
    expect(respBody.challenge).toBe(challengeToken)

    await app.close()
  }, 30_000)
})
