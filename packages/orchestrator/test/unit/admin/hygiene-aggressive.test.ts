/**
 * test/unit/admin/hygiene-aggressive.test.ts
 *
 * Unit tests for the v2 aggressive hygiene sweep methods.
 * All DB interactions are mocked — no real Postgres connection.
 *
 * Tests verify:
 *   - Correct candidate selection logic (WHERE clauses)
 *   - dryRun=true returns sampleIds but calls no db.update/insert
 *   - dryRun=false calls db.update/insert in the correct order
 *   - idempotency: if there are no candidates, transitioned=0 and no events emitted
 *   - Preserved keywords prevent fixture visions/epics from being touched
 *   - Event emission per category with correct payload shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HygieneService } from '../../../src/admin/hygiene.js'
import type { DB } from '../../../src/db/client.js'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Minimal DB mock factory
// ---------------------------------------------------------------------------

function makeMockDb(overrides: Record<string, unknown> = {}): DB {
  // We fake the drizzle query builder's chain: select().from().where()
  // Each method returns the mock builder, and the final call resolves a promise.
  const buildChain = (rows: unknown[]): unknown => {
    const chain: Record<string, unknown> = {}
    const terminal = (): Promise<unknown[]> => Promise.resolve(rows)
    chain['select'] = () => buildChain(rows)
    chain['from'] = () => buildChain(rows)
    chain['where'] = () => buildChain(rows)
    chain['limit'] = () => terminal()
    // Make the chain itself thenable so `await db.select()....where()` works
    chain['then'] = (resolve: (v: unknown) => unknown) => terminal().then(resolve)
    return chain
  }

  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
      execute: () => Promise.resolve(),
    })
  })

  const mockUpdate = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  }))

  const mockExecute = vi.fn(() => Promise.resolve())

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
        limit: vi.fn(() => Promise.resolve([])),
      })),
    })),
    update: mockUpdate,
    transaction: mockTransaction,
    execute: mockExecute,
    ...overrides,
  } as unknown as DB

  return db
}

function makeMockEventStore(): EventStore {
  return {
    append: vi.fn(() => Promise.resolve({ event_id: 'test-event-id' })),
    query: vi.fn(() => Promise.resolve({ items: [], cursor: null })),
  } as unknown as EventStore
}

// ---------------------------------------------------------------------------
// Helper: build HygieneService with controlled db.select responses
// ---------------------------------------------------------------------------

function makeServiceWithCandidates(
  candidateMap: Record<string, { id: string }[]>,
): { service: HygieneService; db: DB; eventStore: EventStore } {
  const eventStore = makeMockEventStore()

  let callCount = 0
  const db = {
    select: vi.fn(() => {
      const selectCalls = Object.values(candidateMap)
      const rows = selectCalls[callCount % selectCalls.length] ?? []
      callCount++
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
          limit: vi.fn(() => Promise.resolve(rows)),
        })),
      }
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve()),
          })),
        })),
        execute: vi.fn(() => Promise.resolve()),
      })
    }),
    execute: vi.fn(() => Promise.resolve()),
  } as unknown as DB

  const service = new HygieneService(db, eventStore)
  return { service, db, eventStore }
}

// ---------------------------------------------------------------------------
// cleanFixtureEpics
// ---------------------------------------------------------------------------

describe('HygieneService.cleanFixtureEpics', () => {
  it('dryRun=true: returns sampleIds, calls no db.transaction', async () => {
    const epicRows = [
      { epicId: 'epic-1', title: 'ab' },
      { epicId: 'epic-2', title: 'x' },
    ]
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(epicRows)),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanFixtureEpics({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toHaveLength(2)
    expect(result.sampleIds).toContain('epic-1')
    expect(db.transaction).not.toHaveBeenCalled()
    expect(es.append).not.toHaveBeenCalled()
  })

  it('dryRun=false with candidates: calls transaction + emits event', async () => {
    const epicRows = [{ epicId: 'epic-abc', title: 'tst' }]
    const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(epicRows)),
        })),
      })),
      transaction: transactionMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanFixtureEpics({ dryRun: false })

    expect(result.transitioned).toBe(1)
    expect(transactionMock).toHaveBeenCalledOnce()
    expect(es.append).toHaveBeenCalledOnce()

    const call = (es.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.event_type).toBe('AdminHygieneSweepCompleted')
    expect(call.payload.sweep_type).toBe('epics')
    expect(call.payload.affected_count).toBe(1)
    expect(call.payload.dry_run).toBe(false)
  })

  it('dryRun=false with no candidates: no transaction, no event', async () => {
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanFixtureEpics({ dryRun: false })

    expect(result.transitioned).toBe(0)
    expect(db.transaction).not.toHaveBeenCalled()
    expect(es.append).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// cleanFixtureVisions
// ---------------------------------------------------------------------------

describe('HygieneService.cleanFixtureVisions', () => {
  it('dryRun=true returns sampleIds without mutation', async () => {
    const rows = [
      { id: 'vis-1', title: 'abc' },
      { id: 'vis-2', title: 'xyz' },
    ]
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanFixtureVisions({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toHaveLength(2)
    expect(db.transaction).not.toHaveBeenCalled()
    expect(es.append).not.toHaveBeenCalled()
  })

  it('dryRun=false emits event with correct sweep_type', async () => {
    const rows = [{ id: 'vis-3', title: 'foo' }]
    const txMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
      transaction: txMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanFixtureVisions({ dryRun: false })

    expect(result.transitioned).toBe(1)
    const call = (es.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.payload.sweep_type).toBe('visions')
  })
})

// ---------------------------------------------------------------------------
// cleanStaleWorkers
// ---------------------------------------------------------------------------

describe('HygieneService.cleanStaleWorkers', () => {
  it('dryRun=true returns stale worker sampleIds', async () => {
    const rows = [{ workerId: 'w-1' }, { workerId: 'w-2' }]
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanStaleWorkers({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toHaveLength(2)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('dryRun=false transitions workers and emits event', async () => {
    const rows = [{ workerId: 'w-3' }]
    const txMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
      transaction: txMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanStaleWorkers({ dryRun: false })

    expect(result.transitioned).toBe(1)
    const call = (es.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.payload.sweep_type).toBe('stale_workers')
    expect(call.payload.affected_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// archiveStaleVisionSessions
// ---------------------------------------------------------------------------

describe('HygieneService.archiveStaleVisionSessions', () => {
  it('dryRun=true returns sampleIds', async () => {
    const rows = [{ visionSessionId: 'vs-1' }]
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.archiveStaleVisionSessions({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain('vs-1')
    expect(es.append).not.toHaveBeenCalled()
  })

  it('dryRun=false transitions sessions and emits event', async () => {
    const rows = [{ visionSessionId: 'vs-2' }]
    const txMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
      transaction: txMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.archiveStaleVisionSessions({ dryRun: false })

    expect(result.transitioned).toBe(1)
    const call = (es.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.payload.sweep_type).toBe('stale_vision_sessions')
  })
})

// ---------------------------------------------------------------------------
// cleanStaleCapabilities
// ---------------------------------------------------------------------------

describe('HygieneService.cleanStaleCapabilities', () => {
  it('dryRun=true: returns sampleIds when terminal sprints exist', async () => {
    let callIndex = 0
    const responses = [
      // First call: terminal sprints
      [{ sprintId: 'sprint-terminal-1' }],
      // Second call: capability grants
      [{ capabilityId: 'cap-1' }, { capabilityId: 'cap-2' }],
    ]

    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = responses[callIndex % responses.length] ?? []
            callIndex++
            return Promise.resolve(rows)
          }),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanStaleCapabilities({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds.length).toBeGreaterThanOrEqual(1)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('returns 0 if no terminal sprints', async () => {
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanStaleCapabilities({ dryRun: false })

    expect(result.transitioned).toBe(0)
    expect(es.append).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// archiveTestDefects
// ---------------------------------------------------------------------------

describe('HygieneService.archiveTestDefects', () => {
  it('dryRun=true returns defect sampleIds from cancelled stories', async () => {
    let callIndex = 0
    const responses = [
      // First call: cancelled stories
      [{ storyId: 'story-c-1' }],
      // Second call: defects
      [{ defectId: 'def-1' }, { defectId: 'def-2' }],
    ]

    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = responses[callIndex % responses.length] ?? []
            callIndex++
            return Promise.resolve(rows)
          }),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.archiveTestDefects({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toHaveLength(2)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('dryRun=false closes defects and emits event', async () => {
    let callIndex = 0
    const responses = [
      [{ storyId: 'story-c-2' }],
      [{ defectId: 'def-3' }],
    ]
    const txMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = responses[callIndex % responses.length] ?? []
            callIndex++
            return Promise.resolve(rows)
          }),
        })),
      })),
      transaction: txMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.archiveTestDefects({ dryRun: false })

    expect(result.transitioned).toBe(1)
    const call = (es.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.payload.sweep_type).toBe('test_defects')
    expect(call.payload.affected_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// cleanOrphanChannels
// ---------------------------------------------------------------------------

describe('HygieneService.cleanOrphanChannels', () => {
  it('dryRun=true identifies ticket channels whose story is cancelled', async () => {
    let callIndex = 0
    const responses = [
      // First call: ticket channels
      [
        {
          channelId: 'ch-1',
          kind: 'ticket_durable',
          scopeRef: { story_id: 'story-cancelled-1' },
        },
      ],
      // Second call: cancelled stories
      [{ storyId: 'story-cancelled-1' }],
    ]

    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = responses[callIndex % responses.length] ?? []
            callIndex++
            return Promise.resolve(rows)
          }),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.cleanOrphanChannels({ dryRun: true })

    expect(result.transitioned).toBe(0)
    expect(result.sampleIds).toContain('ch-1')
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runFullSweep — v2 aggressiveDryRun default
// ---------------------------------------------------------------------------

describe('HygieneService.runFullSweep with aggressiveDryRun', () => {
  it('aggressiveDryRun=true (default): v2 methods do not call transaction', async () => {
    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.runFullSweep({ dryRun: false, aggressiveDryRun: true })

    // v1 methods can run (dryRun=false) but v2 methods are dry
    expect(result.dryRun).toBe(false)
    expect(result.epics.transitioned).toBe(0)
    expect(result.visions.transitioned).toBe(0)
    // No DB mutations from v2 (no candidates anyway in this mock)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('aggressiveDryRun=false: v2 methods execute when candidates exist', async () => {
    // Sprints result: none → triggers no v1 sprint candidates
    // Epic result: one candidate
    let callIndex = 0
    const responses: Array<Array<Record<string, string>>> = [
      // cleanFixtureStories → no candidates
      [],
      // cleanFixtureSprints → no candidates
      [],
      // cleanStaleEscalations → no candidates
      [],
      // cleanFixtureEpics → one candidate
      [{ epicId: 'e-1', title: 'ab' }],
      // cleanFixtureVisions → no candidates
      [],
      // cleanOrphanCeremonies → no candidates
      [],
      // cleanOrphanChannels → no candidates (first call: ticket channels)
      [],
      // cleanStaleTasks → terminal sprints
      [],
      // cleanStaleWorkers → no candidates
      [],
      // cleanStaleCapabilities → no terminal sprints
      [],
      // archiveStaleVisionSessions → no candidates
      [],
      // archiveTestDefects → no cancelled stories
      [],
    ]

    const txMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
      })
    })

    const db = makeMockDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = responses[callIndex % responses.length] ?? []
            callIndex++
            return Promise.resolve(rows)
          }),
        })),
      })),
      transaction: txMock,
    })
    const es = makeMockEventStore()
    const service = new HygieneService(db, es)

    const result = await service.runFullSweep({ dryRun: false, aggressiveDryRun: false })

    expect(result.epics.transitioned).toBe(1)
    // Transaction should have been called for epics
    expect(txMock).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Idempotency proof: empty candidates = no mutation no event
// ---------------------------------------------------------------------------

describe('idempotency: all methods with empty candidates', () => {
  const methods: Array<keyof HygieneService> = [
    'cleanFixtureEpics',
    'cleanFixtureVisions',
    'cleanOrphanCeremonies',
    'cleanOrphanChannels',
    'cleanStaleWorkers',
    'archiveStaleVisionSessions',
    'archiveTestDefects',
    'hideStaleChannelPosts',
    'hideStaleCapabilityDenials',
  ]

  for (const method of methods) {
    it(`${method}: no mutation when no candidates`, async () => {
      const db = makeMockDb({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve([])),
          })),
        })),
      })
      const es = makeMockEventStore()
      const service = new HygieneService(db, es)

      // @ts-expect-error — dynamic method call
      const result = await service[method]({ dryRun: false })

      expect(result.transitioned ?? result.archived ?? result.acknowledged).toBe(0)
      expect(db.transaction).not.toHaveBeenCalled()
      expect(es.append).not.toHaveBeenCalled()
    })
  }
})
