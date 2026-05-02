/**
 * Unit tests for BoardDiscoveryService + heuristic mapping + resolver.
 *
 * The Monday HTTP layer is mocked at the fetch boundary using a custom
 * fetchImpl injected into DefaultMondayClient (same pattern as monday-sync
 * tests). All other code is exercised end-to-end with the real Drizzle DB.
 */

import { describe, it, expect } from 'vitest'

import { DefaultMondayClient } from '../../../src/backlog/monday-client.js'
import {
  DefaultBoardDiscoveryService,
  parseSettingsStr,
  parseStatusLabels,
  mapMondayTypeToCanonical,
  type BoardSchema,
} from '../../../src/backlog/board-discovery.js'
import {
  heuristicMap,
  matchLabelToState,
  ORBITAL_STATES,
  type BoardMapping,
  type BoardMappingService,
} from '../../../src/backlog/board-mapping.js'
import { DefaultBoardMappingResolver } from '../../../src/backlog/board-mapping-resolver.js'

// ---------------------------------------------------------------------------
// fetch mock — same pattern as monday-sync.test.ts
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

// ---------------------------------------------------------------------------
// Type-mapping unit tests
// ---------------------------------------------------------------------------

describe('mapMondayTypeToCanonical', () => {
  it('maps color/status aliases to status', () => {
    expect(mapMondayTypeToCanonical('color')).toBe('status')
    expect(mapMondayTypeToCanonical('status')).toBe('status')
    expect(mapMondayTypeToCanonical('color-picker')).toBe('status')
  })
  it('maps numbers/numeric to numbers', () => {
    expect(mapMondayTypeToCanonical('numbers')).toBe('numbers')
    expect(mapMondayTypeToCanonical('numeric')).toBe('numbers')
  })
  it('maps long_text and long-text to long-text', () => {
    expect(mapMondayTypeToCanonical('long_text')).toBe('long-text')
    expect(mapMondayTypeToCanonical('long-text')).toBe('long-text')
  })
  it('maps people aliases', () => {
    expect(mapMondayTypeToCanonical('people')).toBe('people')
    expect(mapMondayTypeToCanonical('multiple-person')).toBe('people')
    expect(mapMondayTypeToCanonical('multiple_person')).toBe('people')
  })
  it('falls through to other on unknown', () => {
    expect(mapMondayTypeToCanonical('xyz')).toBe('other')
    expect(mapMondayTypeToCanonical('')).toBe('other')
    expect(mapMondayTypeToCanonical(null)).toBe('other')
  })
})

describe('parseSettingsStr', () => {
  it('returns empty object on null/empty/garbage', () => {
    expect(parseSettingsStr(null)).toEqual({})
    expect(parseSettingsStr('')).toEqual({})
    expect(parseSettingsStr('not-json')).toEqual({})
  })
  it('parses valid JSON', () => {
    expect(parseSettingsStr('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('parseStatusLabels', () => {
  it('parses Monday string-map labels with colors', () => {
    const settings = {
      labels: { '0': 'Backlog', '1': 'In Progress', '2': 'Done' },
      labels_colors: {
        '0': { color: '#aaa' },
        '1': { color: '#bbb' },
        '2': { color: '#ccc' },
      },
    }
    const labels = parseStatusLabels(settings)
    expect(labels.length).toBe(3)
    expect(labels[0]).toMatchObject({ id: 0, label: 'Backlog', color: '#aaa' })
    expect(labels[2]).toMatchObject({ id: 2, label: 'Done', color: '#ccc' })
  })
  it('parses array-of-objects form', () => {
    const settings = {
      labels: [
        { id: 5, name: 'Working', color: '#f00' },
        { id: 6, label: 'Stuck', color: '#000' },
      ],
    }
    const labels = parseStatusLabels(settings)
    expect(labels.length).toBe(2)
    expect(labels[0]).toMatchObject({ id: 5, label: 'Working', color: '#f00' })
    expect(labels[1]).toMatchObject({ id: 6, label: 'Stuck', color: '#000' })
  })
  it('returns empty on missing settings', () => {
    expect(parseStatusLabels(null)).toEqual([])
    expect(parseStatusLabels({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// matchLabelToState
// ---------------------------------------------------------------------------

describe('matchLabelToState', () => {
  it('maps common labels deterministically', () => {
    expect(matchLabelToState('Working on it')).toBe('in_progress')
    expect(matchLabelToState('In Progress')).toBe('in_progress')
    expect(matchLabelToState('To Do')).toBe('ready')
    expect(matchLabelToState('Backlog')).toBe('backlog')
    expect(matchLabelToState('Done')).toBe('done')
    expect(matchLabelToState('Approved')).toBe('accepted')
    expect(matchLabelToState('Stuck')).toBe('defective')
    expect(matchLabelToState('In Review')).toBe('in_review')
    expect(matchLabelToState('PR Open')).toBe('in_review')
  })
  it('falls back to backlog on unknown', () => {
    expect(matchLabelToState('Random Thing')).toBe('backlog')
    expect(matchLabelToState('')).toBe('backlog')
  })
})

// ---------------------------------------------------------------------------
// heuristicMap — fixture board shapes
// ---------------------------------------------------------------------------

const PROJECT_ID = '01933333-1111-7333-8333-333333333333'

function makeSchema(partial: Partial<BoardSchema>): BoardSchema {
  return {
    board_id: 'b1',
    workspace_id: 'w1',
    board_name: 'Test Board',
    discovered_at: new Date().toISOString(),
    columns: [],
    status_columns: [],
    has_subitems: false,
    sample_items: [],
    workflow_history: [],
    ...partial,
  }
}

describe('heuristicMap — fixture A: subitems-as-AC', () => {
  const schema = makeSchema({
    columns: [
      { column_id: 'status', title: 'Status', type: 'status', settings: {}, sample_values: [] },
      { column_id: 'estimate', title: 'Story Points', type: 'numbers', settings: {}, sample_values: [] },
      { column_id: 'priority', title: 'Priority', type: 'status', settings: {}, sample_values: [] },
      { column_id: 'owner', title: 'Owner', type: 'people', settings: {}, sample_values: [] },
      { column_id: 'subtasks', title: 'Subtasks', type: 'other', settings: {}, sample_values: [] },
    ],
    status_columns: [
      {
        column_id: 'status',
        labels: [
          { id: 0, label: 'Backlog', color: '' },
          { id: 1, label: 'In Progress', color: '' },
          { id: 2, label: 'Done', color: '' },
        ],
      },
    ],
    has_subitems: true,
    subitem_columns: [
      { column_id: 'status', title: 'Status', type: 'status', settings: {}, sample_values: [] },
      { column_id: 'criteria', title: 'Test Criteria', type: 'long-text', settings: {}, sample_values: [] },
    ],
  })

  it('maps status, points, priority, owner, AC=subitem', () => {
    const m = heuristicMap(schema, { projectId: PROJECT_ID })
    expect(m.status_column_id).toBe('status')
    expect(m.estimate_column_id).toBe('estimate')
    expect(m.priority_column_id).toBe('priority')
    expect(m.assignee_column_id).toBe('owner')
    expect(m.story_points_unit).toBe('story_points')
    expect(m.ac_column_id).toBeNull()
    expect(m.ac_subitem_template_id).toBe('criteria')
    expect(m.status_label_to_state).toMatchObject({
      Backlog: 'backlog',
      'In Progress': 'in_progress',
      Done: 'done',
    })
  })
})

describe('heuristicMap — fixture B: text-AC', () => {
  const schema = makeSchema({
    columns: [
      { column_id: 'lifecycle', title: 'Lifecycle', type: 'status', settings: {}, sample_values: [] },
      { column_id: 'effort', title: 'Effort (hours)', type: 'numbers', settings: {}, sample_values: [] },
      { column_id: 'ac', title: 'Acceptance Criteria', type: 'long-text', settings: {}, sample_values: [] },
      { column_id: 'people', title: 'Assignee', type: 'people', settings: {}, sample_values: [] },
    ],
    status_columns: [
      {
        column_id: 'lifecycle',
        labels: [
          { id: 0, label: 'Ready', color: '' },
          { id: 1, label: 'WIP', color: '' },
          { id: 2, label: 'Stuck', color: '' },
          { id: 3, label: 'Approved', color: '' },
        ],
      },
    ],
  })

  it('maps text-based AC and infers hours unit', () => {
    const m = heuristicMap(schema, { projectId: PROJECT_ID })
    expect(m.status_column_id).toBe('lifecycle')
    expect(m.estimate_column_id).toBe('effort')
    expect(m.story_points_unit).toBe('hours')
    expect(m.ac_column_id).toBe('ac')
    expect(m.ac_subitem_template_id).toBeNull()
    expect(m.status_label_to_state).toEqual({
      Ready: 'ready',
      WIP: 'in_progress',
      Stuck: 'defective',
      Approved: 'accepted',
    })
  })
})

describe('heuristicMap — fixture C: no AC at all', () => {
  const schema = makeSchema({
    columns: [
      { column_id: 'state', title: 'State', type: 'status', settings: {}, sample_values: [] },
      { column_id: 'numeric', title: 'Whatever', type: 'numbers', settings: {}, sample_values: [] },
    ],
    status_columns: [
      { column_id: 'state', labels: [{ id: 0, label: 'New', color: '' }] },
    ],
  })

  it('leaves AC fields null and estimate unset because no titled estimate column matches', () => {
    const m = heuristicMap(schema, { projectId: PROJECT_ID })
    expect(m.status_column_id).toBe('state')
    expect(m.ac_column_id).toBeNull()
    expect(m.ac_subitem_template_id).toBeNull()
    // 'Whatever' doesn't match the estimate-title regex so estimate_column_id
    // stays null and story_points_unit stays 'none'.
    expect(m.estimate_column_id).toBeNull()
    expect(m.story_points_unit).toBe('none')
  })
})

describe('heuristicMap — covers >=6 column-type heuristics', () => {
  it('handles status, numbers, text, long-text, people, dropdown, formula, mirror', () => {
    const schema = makeSchema({
      columns: [
        { column_id: 'st', title: 'Status', type: 'status', settings: {}, sample_values: [] },
        { column_id: 'n', title: 'Points', type: 'numbers', settings: {}, sample_values: [] },
        { column_id: 't', title: 'Notes', type: 'text', settings: {}, sample_values: [] },
        { column_id: 'lt', title: 'AC', type: 'long-text', settings: {}, sample_values: [] },
        { column_id: 'p', title: 'Owner', type: 'people', settings: {}, sample_values: [] },
        { column_id: 'd', title: 'Priority', type: 'dropdown', settings: {}, sample_values: [] },
        { column_id: 'f', title: 'Formula', type: 'formula', settings: {}, sample_values: [] },
        { column_id: 'm', title: 'Mirror', type: 'mirror', settings: {}, sample_values: [] },
      ],
      status_columns: [{ column_id: 'st', labels: [] }],
    })
    const m = heuristicMap(schema, { projectId: PROJECT_ID })
    expect(m.status_column_id).toBe('st')
    expect(m.estimate_column_id).toBe('n')
    expect(m.ac_column_id).toBe('lt')
    expect(m.assignee_column_id).toBe('p')
    expect(m.priority_column_id).toBe('d') // priority dropdown wins on title match
    // Formula and mirror are not mapped by the heuristic — they're surfaced
    // in the schema for the user to inspect. That's the correct behavior.
  })
})

// ---------------------------------------------------------------------------
// BoardMappingResolver — uses an in-memory mock service
// ---------------------------------------------------------------------------

class StubMappingService implements BoardMappingService {
  private mapping: BoardMapping | null = null
  setMapping(m: BoardMapping | null): void {
    this.mapping = m
  }
  async propose(): Promise<BoardMapping> {
    throw new Error('not used')
  }
  async confirm(): Promise<void> {
    /* not used */
  }
  async get(): Promise<BoardMapping | null> {
    return this.mapping
  }
}

describe('BoardMappingResolver', () => {
  function makeMapping(overrides: Partial<BoardMapping> = {}): BoardMapping {
    return {
      board_id: 'b1',
      project_id: PROJECT_ID,
      status_column_id: 'st',
      status_label_to_state: { Backlog: 'backlog', Working: 'in_progress', Done: 'done' },
      estimate_column_id: 'pts',
      priority_column_id: 'pr',
      ac_column_id: 'ac',
      ac_subitem_template_id: null,
      assignee_column_id: 'own',
      story_points_unit: 'story_points',
      monday_terminology: { epic: 'epic', story: 'story', task: 'task', sprint: 'sprint' },
      confirmed_at: new Date().toISOString(),
      confirmed_by: 'system:test',
      ...overrides,
    }
  }

  it('returns null when no mapping confirmed', async () => {
    const stub = new StubMappingService()
    const resolver = new DefaultBoardMappingResolver(stub, 0)
    expect(await resolver.resolveStatusColumn(PROJECT_ID)).toBeNull()
    expect((await resolver.resolveACSource(PROJECT_ID)).kind).toBe('none')
    expect(await resolver.resolveEstimateColumn(PROJECT_ID)).toBeNull()
  })

  it('returns the mapped column ids and resolves labels both directions', async () => {
    const stub = new StubMappingService()
    stub.setMapping(makeMapping())
    const resolver = new DefaultBoardMappingResolver(stub, 0)

    const status = await resolver.resolveStatusColumn(PROJECT_ID)
    expect(status?.column_id).toBe('st')
    expect(status?.label_for_state('in_progress')).toBe('Working')
    expect(status?.label_for_state('accepted')).toBeNull() // no label maps to accepted
    expect(status?.state_for_label('Done')).toBe('done')
    expect(status?.state_for_label('Random')).toBeNull()
    expect(status?.labels.sort()).toEqual(['Backlog', 'Done', 'Working'])

    const ac = await resolver.resolveACSource(PROJECT_ID)
    expect(ac.kind).toBe('column')
    expect(ac.column_id).toBe('ac')

    const est = await resolver.resolveEstimateColumn(PROJECT_ID)
    expect(est).toEqual({ column_id: 'pts', unit: 'story_points' })

    expect(await resolver.resolvePriorityColumn(PROJECT_ID)).toEqual({ column_id: 'pr' })
    expect(await resolver.resolveAssigneeColumn(PROJECT_ID)).toEqual({ column_id: 'own' })
  })

  it('prefers subitem AC when both column and subitem are set (defensive — should never happen)', async () => {
    const stub = new StubMappingService()
    stub.setMapping(
      makeMapping({ ac_column_id: 'ac', ac_subitem_template_id: 'subac' }),
    )
    const resolver = new DefaultBoardMappingResolver(stub, 0)
    const ac = await resolver.resolveACSource(PROJECT_ID)
    expect(ac.kind).toBe('subitem')
    expect(ac.subitem_template_id).toBe('subac')
  })

  it('caches with TTL and invalidates on demand', async () => {
    const stub = new StubMappingService()
    stub.setMapping(makeMapping())
    let calls = 0
    const wrapped: BoardMappingService = {
      propose: stub.propose.bind(stub),
      confirm: stub.confirm.bind(stub),
      get: async (id: string) => {
        calls++
        return stub.get(id)
      },
    }
    const resolver = new DefaultBoardMappingResolver(wrapped, 60_000)
    await resolver.getMapping(PROJECT_ID)
    await resolver.getMapping(PROJECT_ID)
    expect(calls).toBe(1)
    resolver.invalidate(PROJECT_ID)
    await resolver.getMapping(PROJECT_ID)
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Integration: Discovery → Monday GraphQL mock
// ---------------------------------------------------------------------------

describe('DefaultBoardDiscoveryService', () => {
  it('pulls schema via a single GraphQL call and parses status labels', async () => {
    const introspectResponse = {
      data: {
        boards: [
          {
            id: 'board-1',
            name: 'Engineering',
            workspace_id: 'ws-7',
            columns: [
              {
                id: 'status',
                title: 'Status',
                type: 'color',
                settings_str: JSON.stringify({
                  labels: { '0': 'Backlog', '1': 'In Progress', '2': 'Done' },
                  labels_colors: {
                    '0': { color: '#aaa' },
                    '1': { color: '#bbb' },
                    '2': { color: '#ccc' },
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
                id: 'people',
                title: 'Owner',
                type: 'multiple-person',
                settings_str: '{}',
              },
            ],
            items_page: {
              items: [
                {
                  id: 'i1',
                  name: 'Task one',
                  column_values: [
                    { id: 'status', value: '{"label":"Backlog"}', type: 'color' },
                    { id: 'pts', value: '5', type: 'numeric' },
                  ],
                },
              ],
            },
          },
        ],
      },
    }
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: introspectResponse }])
    const client = new DefaultMondayClient({ token: 't', fetchImpl })
    const discovery = new DefaultBoardDiscoveryService(client)

    const schema = await discovery.discover('board-1')

    expect(schema.board_id).toBe('board-1')
    expect(schema.board_name).toBe('Engineering')
    expect(schema.workspace_id).toBe('ws-7')
    expect(schema.columns.length).toBe(3)

    const statusCol = schema.columns.find((c) => c.column_id === 'status')!
    expect(statusCol.type).toBe('status')

    expect(schema.status_columns.length).toBe(1)
    expect(schema.status_columns[0]!.labels.length).toBe(3)

    const ptsCol = schema.columns.find((c) => c.column_id === 'pts')!
    expect(ptsCol.type).toBe('numbers')

    const peopleCol = schema.columns.find((c) => c.column_id === 'people')!
    expect(peopleCol.type).toBe('people')

    expect(schema.has_subitems).toBe(false)
    expect(schema.sample_items.length).toBe(1)
    expect(schema.sample_items[0]!.columns).toMatchObject({
      pts: 5,
    })

    expect(calls.length).toBe(1)
  })

  it('throws when MondayClient lacks graphql() (test surrogate without it)', async () => {
    const fakeClient = {
      createSubitem: async () => ({ id: '' }),
      getItem: async () => null,
      getBoardItems: async () => [],
      updateColumnValue: async () => ({ id: '' }),
    }
    const discovery = new DefaultBoardDiscoveryService(
      fakeClient as unknown as DefaultMondayClient,
    )
    await expect(discovery.discover('any')).rejects.toThrow(/graphql/)
  })
})

// ---------------------------------------------------------------------------
// Sanity: ORBITAL_STATES exported
// ---------------------------------------------------------------------------

describe('ORBITAL_STATES', () => {
  it('contains the expected lifecycle states', () => {
    expect(ORBITAL_STATES).toContain('backlog')
    expect(ORBITAL_STATES).toContain('in_progress')
    expect(ORBITAL_STATES).toContain('done')
    expect(ORBITAL_STATES).toContain('accepted')
  })
})
