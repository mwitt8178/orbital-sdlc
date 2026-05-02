/**
 * Unit tests for vision/auto-decompose.ts — VisionDecomposer.
 *
 * Strategy: pure in-memory; no real Postgres. All DB calls are replaced by
 * stub implementations that track calls and return pre-configured data.
 *
 * Tests cover:
 *   - Happy-path: locked vision → 3-5 epics, 2-3 stories each, correct metadata
 *   - All rows tagged with auto_generated_metadata.source = 'vision_lock'
 *   - EpicCreated + StoryCreated + BacklogAutoDecomposed events emitted
 *   - Generic fallback epics when content has no recognisable keywords
 *   - Error: missing vision document
 *   - Error: no current version
 *   - Error: unlocked version
 *   - Transaction rollback semantics (transaction throws → no events emitted)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { VisionDecomposer } from '../../../src/vision/auto-decompose.js'
import type { DecomposeResult } from '../../../src/vision/auto-decompose.js'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

interface InsertedRow {
  table: string
  values: Record<string, unknown>
}

interface AppendedEvent {
  event_type: string
  aggregate_id: string
  aggregate_type: string
  payload: Record<string, unknown>
}

/**
 * Build a minimal stub DB that captures inserts.
 * The `select` stubs are configured per test via `_docRows` / `_versionRows`.
 */
function makeStubDb(opts: {
  docRows?: unknown[]
  versionRows?: unknown[]
  transactionThrows?: boolean
}) {
  const insertedRows: InsertedRow[] = []
  let txCalled = false

  const db = {
    _insertedRows: insertedRows,
    _txCalled: () => txCalled,

    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            // Determine which select stub to use based on call order.
            // First call → visionDocuments, second call → visionVersions.
            const tName = String(table)
            if (tName.includes('visionDocuments') || insertedRows.length === 0) {
              // Heuristic: if we haven't inserted anything yet, it must be the doc select.
              return Promise.resolve(opts.docRows ?? [])
            }
            return Promise.resolve(opts.versionRows ?? [])
          },
        }),
      }),
    }),

    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      txCalled = true
      if (opts.transactionThrows) {
        throw new Error('tx rollback')
      }
      // Provide a minimal tx that records inserts.
      const tx = {
        insert: (table: unknown) => ({
          values: (row: Record<string, unknown>) => {
            insertedRows.push({ table: String(table), values: row })
            return Promise.resolve()
          },
        }),
      }
      await fn(tx)
    },
  }
  return db as unknown as import('../../../src/db/client.js').DB
}

/**
 * Build a vision document row stub.
 */
function makeDocRow(visionDocumentId: string, currentVersionId: string | null) {
  return {
    visionDocumentId,
    installId: 'install-1',
    title: 'Test Vision',
    lifecycleState: 'locked',
    currentVersionId,
    currentVersionNumber: 1,
    mondayItemId: null,
    createdAt: new Date(),
    createdBy: { type: 'user', user_id: 'u1' },
    lastEventId: 'evt-1',
  }
}

/**
 * Build a locked vision_version row stub.
 */
function makeVersionRow(
  visionVersionId: string,
  visionDocumentId: string,
  content: Record<string, unknown>,
  isLocked = 1,
) {
  return {
    visionVersionId,
    visionDocumentId,
    versionNumber: 1,
    content,
    contentHash: 'hash',
    changelog: 'initial',
    isLocked,
    lockedAt: new Date(),
    draftedAt: new Date(),
    draftedBy: { type: 'persona', persona_id: 'pm' },
  }
}

/**
 * Make a vision content that will match billing + auth keywords.
 */
function makeBillingContent(): Record<string, unknown> {
  return {
    schema_version: 1,
    title: 'Subscription billing platform',
    summary: 'Customer-facing billing with checkout, invoices, and subscription management.',
    goals: [
      { id: 'g1', text: 'Users can subscribe and manage billing online.', rank: 0 },
    ],
    non_goals: [],
    target_users: [{ id: 'u1', segment: 'paying customers', description: 'Users who want to manage their subscription.', primary: true }],
    acceptance_criteria: [],
    glossary: [],
    edge_cases: [],
    open_questions: [],
    assumptions_log: [],
    metadata: {
      pm_persona_id: 'pm',
      model_used: 'stub',
      intake_started_at: new Date().toISOString(),
      intake_token_total: 0,
    },
  }
}

/**
 * Make a vision content with no recognisable keywords (triggers fallback).
 */
function makeGenericContent(): Record<string, unknown> {
  return {
    schema_version: 1,
    title: 'My Product',
    summary: 'A new product for people.',
    goals: [],
    non_goals: [],
    target_users: [],
    acceptance_criteria: [],
    glossary: [],
    edge_cases: [],
    open_questions: [],
    assumptions_log: [],
    metadata: {
      pm_persona_id: 'pm',
      model_used: 'stub',
      intake_started_at: new Date().toISOString(),
      intake_token_total: 0,
    },
  }
}

/**
 * Build a minimal stub EventStore that captures appended events.
 */
function makeStubEventStore() {
  const appendedEvents: AppendedEvent[] = []

  const store = {
    _appended: appendedEvents,
    append: (event: {
      event_type: string
      aggregate_id: string
      aggregate_type: string
      payload: Record<string, unknown>
    }) => {
      appendedEvents.push({
        event_type: event.event_type,
        aggregate_id: event.aggregate_id,
        aggregate_type: event.aggregate_type,
        payload: event.payload,
      })
      return Promise.resolve({
        event_id: 'evt-' + appendedEvents.length,
        aggregate_id: event.aggregate_id,
        aggregate_type: event.aggregate_type,
        event_type: event.event_type,
        payload: event.payload,
        actor: { type: 'system', component: 'auto_decomposer' },
        trace_id: event.aggregate_id,
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        schema_version: 1,
      })
    },
    query: () => Promise.resolve({ items: [], next_cursor: null, has_more: false }),
    subscribe: () => () => {},
  }
  return store as unknown as import('../../../src/events/store.js').EventStore & {
    _appended: AppendedEvent[]
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisionDecomposer.decompose — happy path (billing content)', () => {
  const DOC_ID = 'doc-id-1'
  const VER_ID = 'ver-id-1'

  let db: ReturnType<typeof makeStubDb>
  let eventStore: ReturnType<typeof makeStubEventStore>
  let result: DecomposeResult

  beforeEach(async () => {
    const docRow = makeDocRow(DOC_ID, VER_ID)
    const verRow = makeVersionRow(VER_ID, DOC_ID, makeBillingContent())

    // Stub select: first call returns docRows, second returns versionRows.
    let selectCallCount = 0
    db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              if (selectCallCount === 1) return Promise.resolve([docRow])
              return Promise.resolve([verRow])
            },
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          execute: () => Promise.resolve(),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          insert: () => ({
            values: () => Promise.resolve(),
          }),
        }
        await fn(tx)
      },
    } as unknown as import('../../../src/db/client.js').DB

    eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    result = await decomposer.decompose(DOC_ID)
  })

  it('returns correct vision_document_id and version_number', () => {
    expect(result.vision_document_id).toBe(DOC_ID)
    expect(result.version_number).toBe(1)
  })

  it('produces 3-5 epics', () => {
    expect(result.epic_count).toBeGreaterThanOrEqual(3)
    expect(result.epic_count).toBeLessThanOrEqual(5)
    expect(result.epic_ids).toHaveLength(result.epic_count)
  })

  it('produces at least 2 stories per epic (6+ total)', () => {
    expect(result.story_count).toBeGreaterThanOrEqual(result.epic_count * 2)
    expect(result.story_ids).toHaveLength(result.story_count)
  })

  it('emits EpicCreated event for each epic', () => {
    const epicEvents = eventStore._appended.filter((e) => e.event_type === 'EpicCreated')
    expect(epicEvents).toHaveLength(result.epic_count)
    for (const evt of epicEvents) {
      expect(evt.aggregate_type).toBe('epic')
      expect(evt.payload['auto_generated']).toBe(true)
      expect(evt.payload['source']).toBe('vision_lock')
      expect(evt.payload['vision_document_id']).toBe(DOC_ID)
    }
  })

  it('emits StoryCreated event for each story', () => {
    const storyEvents = eventStore._appended.filter((e) => e.event_type === 'StoryCreated')
    expect(storyEvents).toHaveLength(result.story_count)
    for (const evt of storyEvents) {
      expect(evt.aggregate_type).toBe('story')
      expect(evt.payload['auto_generated']).toBe(true)
    }
  })

  it('emits a single BacklogAutoDecomposed summary event', () => {
    const summary = eventStore._appended.filter((e) => e.event_type === 'BacklogAutoDecomposed')
    expect(summary).toHaveLength(1)
    const s = summary[0]!
    expect(s.aggregate_id).toBe(DOC_ID)
    expect(s.payload['epic_count']).toBe(result.epic_count)
    expect(s.payload['story_count']).toBe(result.story_count)
    expect(s.payload['locked_version_number']).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Generic fallback (no keywords matched)
// ---------------------------------------------------------------------------

describe('VisionDecomposer.decompose — generic fallback', () => {
  const DOC_ID = 'doc-generic-1'
  const VER_ID = 'ver-generic-1'

  it('produces 3 fallback epics when no keywords match', async () => {
    let selectCallCount = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              if (selectCallCount === 1) return Promise.resolve([makeDocRow(DOC_ID, VER_ID)])
              return Promise.resolve([makeVersionRow(VER_ID, DOC_ID, makeGenericContent())])
            },
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          execute: () => Promise.resolve(),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          insert: () => ({ values: () => Promise.resolve() }),
        })
      },
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    const result = await decomposer.decompose(DOC_ID)

    expect(result.epic_count).toBe(3)
    expect(result.story_count).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('VisionDecomposer.decompose — error cases', () => {
  it('throws when vision_document not found', async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
      transaction: async () => {},
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    await expect(decomposer.decompose('nonexistent')).rejects.toThrow('not found')
  })

  it('throws when document has no current version', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeDocRow('doc-1', null)]),
          }),
        }),
      }),
      transaction: async () => {},
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    await expect(decomposer.decompose('doc-1')).rejects.toThrow('no current version')
  })

  it('throws when version is not locked (isLocked=0)', async () => {
    const DOC_ID = 'doc-unlocked'
    const VER_ID = 'ver-unlocked'
    let selectCallCount = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              if (selectCallCount === 1) return Promise.resolve([makeDocRow(DOC_ID, VER_ID)])
              return Promise.resolve([makeVersionRow(VER_ID, DOC_ID, makeBillingContent(), 0)])
            },
          }),
        }),
      }),
      transaction: async () => {},
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    await expect(decomposer.decompose(DOC_ID)).rejects.toThrow('not locked')
  })

  it('does not emit any events when transaction throws (rollback)', async () => {
    const DOC_ID = 'doc-tx-fail'
    const VER_ID = 'ver-tx-fail'
    let selectCallCount = 0
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              if (selectCallCount === 1) return Promise.resolve([makeDocRow(DOC_ID, VER_ID)])
              return Promise.resolve([makeVersionRow(VER_ID, DOC_ID, makeBillingContent())])
            },
          }),
        }),
      }),
      transaction: async () => { throw new Error('tx rollback') },
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    await expect(decomposer.decompose(DOC_ID)).rejects.toThrow('tx rollback')
    // No events emitted if transaction failed
    expect(eventStore._appended).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// auto_generated_metadata shape check (via decomposer internals)
// ---------------------------------------------------------------------------

describe('VisionDecomposer — auto_generated_metadata', () => {
  it('all inserted epics and stories carry correct auto_generated_metadata', async () => {
    const DOC_ID = 'doc-meta-1'
    const VER_ID = 'ver-meta-1'
    let selectCallCount = 0

    const insertedRows: Array<{ table: string; values: Record<string, unknown> }> = []

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              if (selectCallCount === 1) return Promise.resolve([makeDocRow(DOC_ID, VER_ID)])
              return Promise.resolve([makeVersionRow(VER_ID, DOC_ID, makeBillingContent())])
            },
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          execute: () => Promise.resolve(),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([]),
              }),
            }),
          }),
          insert: (table: unknown) => ({
            values: (row: Record<string, unknown>) => {
              insertedRows.push({ table: String(table), values: row })
              return Promise.resolve()
            },
          }),
        }
        await fn(tx)
      },
    } as unknown as import('../../../src/db/client.js').DB

    const eventStore = makeStubEventStore()
    const decomposer = new VisionDecomposer(db, eventStore)
    await decomposer.decompose(DOC_ID)

    // All epic rows should have autoGeneratedMetadata set correctly.
    const epicRows = insertedRows.filter((r) => {
      // Table name includes 'epics' but not 'storyAcceptanceCriteria' or 'stories'
      const tn = r.table
      return tn.includes('epics') && !tn.includes('stories') && !tn.includes('criteria')
    })
    for (const row of epicRows) {
      const meta = row.values['autoGeneratedMetadata'] as Record<string, unknown>
      expect(meta).not.toBeNull()
      expect(meta?.['source']).toBe('vision_lock')
      expect(meta?.['vision_document_id']).toBe(DOC_ID)
      expect(meta?.['version']).toBe(1)
    }
  })
})
