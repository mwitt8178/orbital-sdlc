/**
 * Integration test for the Round 5 board discovery + mapping flow.
 *
 * Real Postgres. Real Drizzle DB. Real DefaultMondayClient with the HTTP
 * boundary mocked via undici's MockAgent. The full flow:
 *
 *   1. discover()        — Monday GraphQL mocked, schema persisted
 *   2. propose()         — heuristic mapping (no LLM driver injected)
 *   3. confirm()         — persisted with confirmed_at
 *   4. resolver.*        — returns the right column ids for the project
 *   5. MondaySyncService.onStoryStatusChangedWithMapping → writes to the
 *      mapped column id, NOT a hardcoded 'status'.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { DefaultBacklogService } from '../../../src/backlog/service.js'
import { DefaultMondayClient } from '../../../src/backlog/monday-client.js'
import { DefaultBoardDiscoveryService } from '../../../src/backlog/board-discovery.js'
import {
  DefaultBoardMappingService,
  type BoardMapping,
} from '../../../src/backlog/board-mapping.js'
import { DefaultBoardMappingResolver } from '../../../src/backlog/board-mapping-resolver.js'
import { DefaultMondaySyncService } from '../../../src/backlog/monday-sync.js'
import {
  epics,
  stories,
  storyAcceptanceCriteria,
  mondaySyncState,
} from '../../../src/db/schema/backlog.js'
import {
  boardSchemas,
  boardMappings,
} from '../../../src/db/schema/board-mapping.js'

const ownedEpicIds: string[] = []
const ownedStoryIds: string[] = []
const ownedBoardIds: string[] = []
const ownedProjectIds: string[] = []

let originalDispatcher: ReturnType<typeof getGlobalDispatcher>
let mockAgent: MockAgent

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
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
  if (ownedProjectIds.length > 0) {
    await db
      .delete(boardMappings)
      .where(inArray(boardMappings.projectId, ownedProjectIds))
  }
  if (ownedBoardIds.length > 0) {
    await db.delete(boardSchemas).where(inArray(boardSchemas.boardId, ownedBoardIds))
  }
  await closeDb().catch(() => undefined)
})

describe('Board discovery → mapping → resolver → mapping-aware sync', () => {
  it('discovers a board, persists schema, proposes a heuristic mapping, confirms it, and the resolver returns the right columns', async () => {
    const eventStore = createEventStore(db, sql)
    const projectId = uuidv7()
    const boardId = `int-board-${Date.now()}`
    ownedProjectIds.push(projectId)
    ownedBoardIds.push(boardId)

    const pool = mockAgent.get('https://api.monday.com')
    pool.intercept({ path: '/v2', method: 'POST' }).reply(200, {
      data: {
        boards: [
          {
            id: boardId,
            name: 'Engineering Sprint Board',
            workspace_id: 'ws-12',
            columns: [
              {
                id: 'lifecycle',
                title: 'Lifecycle',
                type: 'color',
                settings_str: JSON.stringify({
                  labels: { '0': 'Backlog', '1': 'Working on it', '2': 'Done', '3': 'Approved' },
                  labels_colors: {
                    '0': { color: '#aaa' },
                    '1': { color: '#fdab3d' },
                    '2': { color: '#00c875' },
                    '3': { color: '#7e3ec8' },
                  },
                }),
              },
              {
                id: 'pts',
                title: 'Story Points',
                type: 'numeric',
                settings_str: '{}',
              },
              {
                id: 'ac_text',
                title: 'Acceptance Criteria',
                type: 'long_text',
                settings_str: '{}',
              },
              {
                id: 'owner',
                title: 'Owner',
                type: 'multiple-person',
                settings_str: '{}',
              },
            ],
            items_page: { items: [] },
          },
        ],
      },
    })

    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl: undiciFetch as unknown as typeof fetch,
    })
    const discovery = new DefaultBoardDiscoveryService(client)
    const mapping = new DefaultBoardMappingService(db, eventStore)
    const resolver = new DefaultBoardMappingResolver(mapping, 0)

    // 1. discover
    const schema = await discovery.discover(boardId)
    expect(schema.board_id).toBe(boardId)
    expect(schema.columns.length).toBe(4)
    expect(schema.status_columns[0]?.labels.length).toBe(4)

    // Persist schema (the tRPC layer does this; here we do it manually).
    await db.insert(boardSchemas).values({
      boardId: schema.board_id,
      schemaJson: schema,
      mondayApiVersion: '2024-01',
      discoveredAt: new Date(),
      schemaVersion: 1,
    })

    // 2. propose
    const proposed = await mapping.propose(schema, { projectId })
    expect(proposed.status_column_id).toBe('lifecycle')
    expect(proposed.estimate_column_id).toBe('pts')
    expect(proposed.story_points_unit).toBe('story_points')
    expect(proposed.ac_column_id).toBe('ac_text')
    expect(proposed.assignee_column_id).toBe('owner')
    expect(proposed.status_label_to_state).toMatchObject({
      Backlog: 'backlog',
      'Working on it': 'in_progress',
      Done: 'done',
      Approved: 'accepted',
    })

    // 3. confirm
    await mapping.confirm(proposed, { type: 'system', component: 'orchestrator' })

    // 4. resolver returns mapped columns
    const status = await resolver.resolveStatusColumn(projectId)
    expect(status?.column_id).toBe('lifecycle')
    expect(status?.label_for_state('in_progress')).toBe('Working on it')
    expect(status?.label_for_state('accepted')).toBe('Approved')

    const ac = await resolver.resolveACSource(projectId)
    expect(ac.kind).toBe('column')
    expect(ac.column_id).toBe('ac_text')

    const est = await resolver.resolveEstimateColumn(projectId)
    expect(est).toEqual({ column_id: 'pts', unit: 'story_points' })

    // Verify DB row
    const persisted = await db
      .select()
      .from(boardMappings)
      .where(eq(boardMappings.projectId, projectId))
      .limit(1)
    expect(persisted.length).toBe(1)
    expect(persisted[0]?.confirmedAt).not.toBeNull()
    const persistedMapping = persisted[0]?.mappingJson as BoardMapping
    expect(persistedMapping.status_column_id).toBe('lifecycle')
  })

  it('MondaySyncService.onStoryStatusChangedWithMapping writes to the mapped column, not a hardcoded one', async () => {
    const eventStore = createEventStore(db, sql)
    const backlog = new DefaultBacklogService(db, eventStore)

    const epic = await backlog.createEpic({
      vision_version_id: uuidv7(),
      title: 'Mapped epic',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)

    const story = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'Mapped story',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story.storyId)

    // Pretend Monday already created a subitem for this story so we have a
    // monday_item_id to mutate.
    await db
      .update(stories)
      .set({ mondayItemId: 'monday-mapped-1' })
      .where(eq(stories.storyId, story.storyId))
    const refreshed = await db
      .select()
      .from(stories)
      .where(eq(stories.storyId, story.storyId))
    const storyRow = refreshed[0]!

    const projectId = uuidv7()
    const boardId = `mapped-${Date.now()}`
    ownedProjectIds.push(projectId)
    ownedBoardIds.push(boardId)

    // Pre-confirm a mapping that points status to a NON-default column id
    // ("custom_lifecycle"). If the sync service hardcoded 'status' the test
    // would still pass with a false positive — so we deliberately use a
    // distinct column id and assert the GraphQL request carries it.
    const mapping = new DefaultBoardMappingService(db, eventStore)
    const proposedMapping: BoardMapping = {
      board_id: boardId,
      project_id: projectId,
      status_column_id: 'custom_lifecycle',
      status_label_to_state: { Building: 'in_progress', Shipped: 'done' },
      estimate_column_id: null,
      priority_column_id: null,
      ac_column_id: null,
      ac_subitem_template_id: null,
      assignee_column_id: null,
      story_points_unit: 'none',
      monday_terminology: { epic: 'epic', story: 'story', task: 'task', sprint: 'sprint' },
      confirmed_at: null,
      confirmed_by: null,
    }
    await mapping.confirm(proposedMapping, { type: 'system', component: 'orchestrator' })

    const resolver = new DefaultBoardMappingResolver(mapping, 0)

    // Mock the change_column_value GraphQL response and capture its body.
    const pool = mockAgent.get('https://api.monday.com')
    let captured: { variables?: Record<string, unknown> } | null = null
    pool.intercept({ path: '/v2', method: 'POST' }).reply((opts) => {
      const raw = opts.body
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as { variables?: Record<string, unknown> }
        captured = parsed
      }
      return {
        statusCode: 200,
        data: JSON.stringify({ data: { change_column_value: { id: 'monday-mapped-1' } } }),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      }
    })

    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl: undiciFetch as unknown as typeof fetch,
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client, {
      mappingResolver: resolver,
    })

    const result = await sync.onStoryStatusChangedWithMapping(
      storyRow,
      boardId,
      projectId,
      'in_progress',
    )
    expect(result.skipped).toBe(false)
    expect(captured).not.toBeNull()
    const vars = (captured as unknown as { variables?: Record<string, unknown> }).variables ?? {}
    expect(vars['columnId']).toBe('custom_lifecycle')
    expect(vars['itemId']).toBe('monday-mapped-1')
    expect(typeof vars['value']).toBe('string')
    const valueObj = JSON.parse(String(vars['value'] ?? '{}')) as { label?: string }
    expect(valueObj.label).toBe('Building')
  })

  it('skips the write with a clear reason when no mapping is confirmed for the project', async () => {
    const eventStore = createEventStore(db, sql)
    const backlog = new DefaultBacklogService(db, eventStore)

    const epic = await backlog.createEpic({
      vision_version_id: uuidv7(),
      title: 'Unmapped epic',
      rationale: 'r',
      priority: 1,
    })
    ownedEpicIds.push(epic.epicId)
    const story = await backlog.createStory({
      epic_id: epic.epicId,
      title: 'Unmapped story',
      description: 'd',
      acceptance_criteria: [{ text: 'AC' }],
    })
    ownedStoryIds.push(story.storyId)
    await db
      .update(stories)
      .set({ mondayItemId: 'monday-unmapped-1' })
      .where(eq(stories.storyId, story.storyId))
    const refreshed = await db
      .select()
      .from(stories)
      .where(eq(stories.storyId, story.storyId))
    const storyRow = refreshed[0]!

    const mapping = new DefaultBoardMappingService(db, eventStore)
    const resolver = new DefaultBoardMappingResolver(mapping, 0)

    const client = new DefaultMondayClient({
      token: 't',
      fetchImpl: undiciFetch as unknown as typeof fetch,
    })
    const sync = new DefaultMondaySyncService(db, eventStore, client, {
      mappingResolver: resolver,
    })

    const result = await sync.onStoryStatusChangedWithMapping(
      storyRow,
      'no-such-board',
      uuidv7(), // some random project id with no mapping
      'in_progress',
    )
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_mapping')
  })
})
