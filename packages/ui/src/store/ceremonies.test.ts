/**
 * Tests for ceremonies store — Round 5 additions.
 *
 * Covers: list, setList, upsertCeremony, reset, CeremonyTrigger shape.
 * Backward-compat: active, appendStatement still work as before.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useCeremoniesStore, type CeremonyView, type CeremonyTrigger } from './ceremonies.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeCeremony(id: string, overrides: Partial<CeremonyView> = {}): CeremonyView {
  return {
    ceremonyId: id,
    kind: 'standup',
    title: `Ceremony ${id}`,
    startedAt: new Date().toISOString(),
    participants: [],
    statements: [],
    output: null,
    closedAt: null,
    ...overrides,
  }
}

const SAMPLE_TRIGGER: CeremonyTrigger = {
  rule_id: 'backlog-grooming',
  trigger_event_id: 'evt-001',
  reason: '5 ungroomed stories',
}

beforeEach(() => {
  useCeremoniesStore.setState({ active: null, list: [] })
})

// ---------------------------------------------------------------------------
// list / setList
// ---------------------------------------------------------------------------

describe('useCeremoniesStore — list', () => {
  it('starts with an empty list', () => {
    expect(useCeremoniesStore.getState().list).toEqual([])
  })

  it('setList replaces the list entirely', () => {
    const ceremonies = [makeCeremony('c1'), makeCeremony('c2')]
    useCeremoniesStore.getState().setList(ceremonies)
    expect(useCeremoniesStore.getState().list).toHaveLength(2)
    expect(useCeremoniesStore.getState().list[0]!.ceremonyId).toBe('c1')
  })

  it('setList overwrites a previous list', () => {
    useCeremoniesStore.getState().setList([makeCeremony('old')])
    useCeremoniesStore.getState().setList([makeCeremony('new1'), makeCeremony('new2')])
    expect(useCeremoniesStore.getState().list).toHaveLength(2)
    expect(useCeremoniesStore.getState().list.some((c) => c.ceremonyId === 'old')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// upsertCeremony
// ---------------------------------------------------------------------------

describe('useCeremoniesStore — upsertCeremony', () => {
  it('inserts a new ceremony at the front of the list', () => {
    useCeremoniesStore.getState().setList([makeCeremony('c1')])
    useCeremoniesStore.getState().upsertCeremony(makeCeremony('c2'))
    const list = useCeremoniesStore.getState().list
    expect(list).toHaveLength(2)
    expect(list[0]!.ceremonyId).toBe('c2')
  })

  it('updates an existing ceremony in-place', () => {
    useCeremoniesStore.getState().setList([makeCeremony('c1')])
    const updated = makeCeremony('c1', { title: 'Updated title', trigger: SAMPLE_TRIGGER })
    useCeremoniesStore.getState().upsertCeremony(updated)
    const list = useCeremoniesStore.getState().list
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe('Updated title')
    expect(list[0]!.trigger).toEqual(SAMPLE_TRIGGER)
  })

  it('does not duplicate an existing ceremony', () => {
    useCeremoniesStore.getState().setList([makeCeremony('c1'), makeCeremony('c2')])
    useCeremoniesStore.getState().upsertCeremony(makeCeremony('c1', { kind: 'retro' }))
    expect(useCeremoniesStore.getState().list).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// trigger field on CeremonyView
// ---------------------------------------------------------------------------

describe('CeremonyView trigger field', () => {
  it('ceremony without trigger field has no trigger', () => {
    const c = makeCeremony('c1')
    expect(c.trigger).toBeUndefined()
  })

  it('ceremony with trigger carries rule_id, trigger_event_id, reason', () => {
    const c = makeCeremony('c1', { trigger: SAMPLE_TRIGGER })
    expect(c.trigger?.rule_id).toBe('backlog-grooming')
    expect(c.trigger?.trigger_event_id).toBe('evt-001')
    expect(c.trigger?.reason).toBe('5 ungroomed stories')
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('useCeremoniesStore — reset', () => {
  it('clears both active and list', () => {
    useCeremoniesStore.getState().setList([makeCeremony('c1')])
    useCeremoniesStore.getState().setActive(makeCeremony('c1'))
    useCeremoniesStore.getState().reset()
    expect(useCeremoniesStore.getState().active).toBeNull()
    expect(useCeremoniesStore.getState().list).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Backward-compat: existing active / appendStatement still work
// ---------------------------------------------------------------------------

describe('useCeremoniesStore — active ceremony (backward compat)', () => {
  it('setActive populates active', () => {
    const c = makeCeremony('c1')
    useCeremoniesStore.getState().setActive(c)
    expect(useCeremoniesStore.getState().active?.ceremonyId).toBe('c1')
  })

  it('appendStatement adds to active.statements', () => {
    useCeremoniesStore.getState().setActive(makeCeremony('c1'))
    useCeremoniesStore.getState().appendStatement({
      statementId: 's1',
      personaRole: 'arch-lead',
      body: 'Hello',
      occurredAt: new Date().toISOString(),
    })
    expect(useCeremoniesStore.getState().active?.statements).toHaveLength(1)
    expect(useCeremoniesStore.getState().active?.statements[0]?.body).toBe('Hello')
  })

  it('appendStatement is a no-op when no active ceremony', () => {
    useCeremoniesStore.getState().appendStatement({
      statementId: 's1',
      personaRole: 'arch-lead',
      body: 'Hello',
      occurredAt: new Date().toISOString(),
    })
    expect(useCeremoniesStore.getState().active).toBeNull()
  })
})
