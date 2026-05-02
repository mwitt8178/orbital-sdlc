/**
 * Test helpers for ceremony-trigger unit tests.
 *
 * Each rule unit test wires up:
 *   - a synthetic EventEnvelope
 *   - a SqlMockingDb whose execute() pattern-matches on SQL text
 *
 * The TriggerContext is built once from these fakes; rule.match is awaited and
 * the returned spec (or null) is asserted.
 */

import type { EventEnvelope } from '@orbital/types'
import type { TriggerContext } from '../../../../src/comms/ceremony-scheduler.js'

interface SqlMatcher {
  /** Substring(s) that must all appear in the rendered SQL text. */
  contains: string[]
  /** Result rows returned. */
  rows: unknown[]
}

interface QueryChunk {
  value?: string[]
}

function flattenSql(query: unknown): { text: string; params: unknown[] } {
  const q = query as { queryChunks?: unknown[] }
  const chunks = Array.isArray(q.queryChunks) ? q.queryChunks : []
  let text = ''
  const params: unknown[] = []
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'value' in (chunk as QueryChunk)) {
      const v = (chunk as QueryChunk).value
      text += Array.isArray(v) ? v.join('') : String(v ?? '')
    } else {
      params.push(chunk)
    }
  }
  return { text, params }
}

export class SqlMockingDb {
  private matchers: SqlMatcher[] = []

  on(contains: string[], rows: unknown[]): this {
    this.matchers.push({ contains, rows })
    return this
  }

  async execute<T>(query: unknown): Promise<T> {
    const { text } = flattenSql(query)
    for (const m of this.matchers) {
      if (m.contains.every((c) => text.includes(c))) {
        return m.rows as unknown as T
      }
    }
    return [] as unknown as T
  }
}

export function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: 'evt-test',
    aggregate_id: 'agg-test',
    aggregate_type: 'sprint',
    event_type: 'TestEvent',
    payload: {},
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: 'trace-test',
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  } as EventEnvelope
}

export function makeContext(db: SqlMockingDb): TriggerContext {
  return {
    db: db as unknown as TriggerContext['db'],
    eventStore: {} as TriggerContext['eventStore'],
    ceremonyService: {} as TriggerContext['ceremonyService'],
    alreadyFired: async () => false,
  }
}
