/**
 * Unit tests for CeremonyScheduler.
 *
 * Verifies the scheduler core (not individual rules; those have their own
 * tests in ceremony-triggers/*.test.ts):
 *   - rules with non-matching event_types are skipped
 *   - matching rules whose match() returns null don't schedule
 *   - matching rules that return a spec call CeremonyService.schedule
 *   - dedupe: same (rule_id, trigger_event_id) doesn't schedule twice
 *   - rule errors are isolated (one bad rule doesn't block others)
 *
 * The DB is a minimal in-memory shim that emulates the SQL the scheduler
 * actually runs (INSERT...ON CONFLICT DO NOTHING + UPDATE + SELECT 1).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { EventEnvelope } from '@orbital/types'
import {
  DefaultCeremonyScheduler,
  type CeremonyTriggerRule,
  type CeremonySpec,
} from '../../../src/comms/ceremony-scheduler.js'

// ---------------------------------------------------------------------------
// In-memory shims
// ---------------------------------------------------------------------------

interface FakeFiringRow {
  ruleId: string
  triggerEventId: string
  ceremonyId: string | null
}

/**
 * Walk a drizzle `sql` template-tagged object and produce
 *   { text, params }
 * where text is the concatenation of the static fragments and params is the
 * ordered list of interpolated values.
 */
function flattenSql(query: unknown): { text: string; params: unknown[] } {
  const q = query as { queryChunks?: unknown[] }
  const chunks = Array.isArray(q.queryChunks) ? q.queryChunks : []
  let text = ''
  const params: unknown[] = []
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'value' in (chunk as Record<string, unknown>)) {
      const v = (chunk as { value: string[] }).value
      text += Array.isArray(v) ? v.join('') : String(v)
    } else {
      params.push(chunk)
    }
  }
  return { text, params }
}

class FakeDb {
  firings = new Map<string, FakeFiringRow>()

  // The scheduler uses db.execute with parameterized SQL strings. We pattern
  // match on the call shape rather than parsing SQL: each call is identified
  // by the first SQL fragment.
  async execute<T>(query: unknown): Promise<T> {
    const { text, params } = flattenSql(query)
    if (text.includes('INSERT INTO ceremony_trigger_firings')) {
      const [ruleId, triggerEventId] = params as [string, string]
      const key = `${ruleId}::${triggerEventId}`
      if (this.firings.has(key)) {
        return [] as unknown as T
      }
      this.firings.set(key, { ruleId, triggerEventId, ceremonyId: null })
      return [{ rule_id: ruleId, trigger_event_id: triggerEventId }] as unknown as T
    }
    if (text.includes('FROM ceremony_trigger_firings') && text.includes('SELECT 1')) {
      const [ruleId, triggerEventId] = params as [string, string]
      const key = `${ruleId}::${triggerEventId}`
      return (this.firings.has(key) ? [{ exists: true }] : []) as unknown as T
    }
    return [] as unknown as T
  }

  // The scheduler uses .update().set().where() (drizzle chain) to update
  // the firing row's ceremony_id. We provide a minimal fluent stub that
  // updates the in-memory map.
  update(_table: unknown): { set: (data: { ceremonyId: string }) => { where: (cond: unknown) => Promise<void> } } {
    return {
      set: (data) => ({
        where: async () => {
          for (const [, row] of this.firings) {
            if (row.ceremonyId === null) {
              row.ceremonyId = data.ceremonyId
            }
          }
        },
      }),
    }
  }
}

interface ScheduleCall {
  ceremonyType: string
  scope: Record<string, unknown>
  invitedRoles?: string[]
}

class FakeCeremonyService {
  scheduleCalls: ScheduleCall[] = []
  scheduleResultId: string

  constructor() {
    let counter = 0
    this.scheduleResultId = ''
    // Each call returns a distinct ceremonyId.
    Object.defineProperty(this, 'nextId', {
      get: () => `cer-${++counter}`,
    })
  }

  // Scheduler-facing surface. We type as `any` here for test-ergonomics; the
  // production type is enforced at the call site in ceremony-scheduler.ts.
  schedule = async (params: {
    ceremonyType: string
    scope: Record<string, unknown>
  }): Promise<{ ceremonyId: string; channelId: string }> => {
    this.scheduleCalls.push({
      ceremonyType: params.ceremonyType,
      scope: params.scope,
      invitedRoles: params.scope['invited_roles'] as string[] | undefined,
    })
    const ceremonyId = (this as unknown as { nextId: string }).nextId
    return { ceremonyId, channelId: 'fake-channel' }
  }

  addParticipant = async () => ({ participantId: 'fake' })
  start = async () => {}
  recordTurn = async () => ({ postId: 'p', turnNumber: 1, tokensConsumed: 1, turnsRemaining: 1 })
  callClosure = async () => ({ votePostId: null })
  castVote = async () => ({
    tally: { approve: 0, reject: 0, abstain: 0, approve_with_modifications: 0 },
    isQuorumReached: false,
  })
  writeOutput = async () => ({ outputId: 'o' })
  close = async () => {}
  abort = async () => {}
  getCeremony = async () => null
}

interface AppendedEvent {
  event_type: string
  payload: Record<string, unknown>
}

class FakeEventStore {
  appended: AppendedEvent[] = []

  append = async (e: { event_type: string; payload: Record<string, unknown> }) => {
    this.appended.push({ event_type: e.event_type, payload: e.payload })
    return {
      event_id: 'fake-event-id',
      event_type: e.event_type,
      payload: e.payload,
      ingested_at: new Date().toISOString(),
    } as unknown as EventEnvelope
  }

  query = async () => ({ items: [], next_cursor: null, has_more: false })
  subscribe = (_cursor: string | null, _handler: (e: EventEnvelope) => void) => {
    return () => {}
  }
}

function envelope(eventType: string, eventId: string, aggregateId = 'agg-1'): EventEnvelope {
  return {
    event_id: eventId,
    aggregate_id: aggregateId,
    aggregate_type: 'sprint',
    event_type: eventType,
    payload: {},
    actor: { type: 'system', component: 'test' },
    trace_id: 'trace-1',
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CeremonyScheduler', () => {
  let db: FakeDb
  let cer: FakeCeremonyService
  let store: FakeEventStore

  beforeEach(() => {
    db = new FakeDb()
    cer = new FakeCeremonyService()
    store = new FakeEventStore()
  })

  function makeScheduler(rules: CeremonyTriggerRule[]) {
    return new DefaultCeremonyScheduler({
      db: db as unknown as never,
      eventStore: store as unknown as never,
      ceremonyService: cer as unknown as never,
      ruleRegistry: rules,
    })
  }

  it('skips rules whose triggers do not match the envelope event_type', async () => {
    const rule: CeremonyTriggerRule = {
      id: 'r1',
      description: 'r1',
      triggers: ['SprintCreated'],
      match: async () => ({
        ceremonyType: 'sprint_planning',
        scope: {},
        triggeredBy: { type: 'system', component: 'test' },
      } as CeremonySpec),
    }
    const scheduler = makeScheduler([rule])
    await scheduler.onEvent(envelope('SprintCompleted', 'e1'))
    expect(cer.scheduleCalls).toHaveLength(0)
    expect(store.appended).toHaveLength(0)
  })

  it('skips rules whose match() returns null', async () => {
    const rule: CeremonyTriggerRule = {
      id: 'r-null',
      description: 'r-null',
      triggers: ['SprintCreated'],
      match: async () => null,
    }
    const scheduler = makeScheduler([rule])
    await scheduler.onEvent(envelope('SprintCreated', 'e2'))
    expect(cer.scheduleCalls).toHaveLength(0)
    expect(store.appended).toHaveLength(0)
  })

  it('schedules a ceremony when match returns a spec', async () => {
    const rule: CeremonyTriggerRule = {
      id: 'r-match',
      description: 'r-match',
      triggers: ['SprintCreated'],
      match: async () => ({
        ceremonyType: 'sprint_planning',
        scope: { sprint_id: 'agg-1' },
        triggeredBy: { type: 'system', component: 'test' },
        invitedRoles: ['pm', 'architect'],
      } as CeremonySpec),
    }
    const scheduler = makeScheduler([rule])
    await scheduler.onEvent(envelope('SprintCreated', 'e3'))
    expect(cer.scheduleCalls).toHaveLength(1)
    expect(cer.scheduleCalls[0]?.ceremonyType).toBe('sprint_planning')
    expect(cer.scheduleCalls[0]?.scope['rule_id']).toBe('r-match')
    expect(cer.scheduleCalls[0]?.scope['invited_roles']).toEqual(['pm', 'architect'])
    expect(cer.scheduleCalls[0]?.scope['auto_scheduled']).toBe(true)
    expect(store.appended).toHaveLength(1)
    expect(store.appended[0]?.event_type).toBe('CeremonyAutoScheduled')
    expect(store.appended[0]?.payload['rule_id']).toBe('r-match')
    expect(store.appended[0]?.payload['trigger_event_id']).toBe('e3')
  })

  it('dedupes: same trigger event fires only once', async () => {
    const rule: CeremonyTriggerRule = {
      id: 'r-dedupe',
      description: 'r-dedupe',
      triggers: ['SprintCreated'],
      match: async () => ({
        ceremonyType: 'sprint_planning',
        scope: {},
        triggeredBy: { type: 'system', component: 'test' },
      } as CeremonySpec),
    }
    const scheduler = makeScheduler([rule])
    const env = envelope('SprintCreated', 'e4')
    await scheduler.onEvent(env)
    await scheduler.onEvent(env) // identical envelope, second invocation
    expect(cer.scheduleCalls).toHaveLength(1)
    expect(store.appended).toHaveLength(1)
  })

  it('isolates rule errors so other rules still run', async () => {
    const ruleBad: CeremonyTriggerRule = {
      id: 'r-bad',
      description: 'bad',
      triggers: ['SprintCreated'],
      match: async () => {
        throw new Error('rule blew up')
      },
    }
    const ruleGood: CeremonyTriggerRule = {
      id: 'r-good',
      description: 'good',
      triggers: ['SprintCreated'],
      match: async () => ({
        ceremonyType: 'ad_hoc',
        scope: {},
        triggeredBy: { type: 'system', component: 'test' },
      } as CeremonySpec),
    }
    const scheduler = makeScheduler([ruleBad, ruleGood])
    await scheduler.onEvent(envelope('SprintCreated', 'e5'))
    expect(cer.scheduleCalls).toHaveLength(1)
    expect(cer.scheduleCalls[0]?.ceremonyType).toBe('ad_hoc')
  })

  it('reports registered rule ids', () => {
    const rule: CeremonyTriggerRule = {
      id: 'r-introspect',
      description: '',
      triggers: ['X'],
      match: async () => null,
    }
    const scheduler = makeScheduler([rule])
    expect(scheduler.registeredRuleIds()).toEqual(['r-introspect'])
  })
})
