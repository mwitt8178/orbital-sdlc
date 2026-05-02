import { describe, it, expect } from 'vitest'
import { codeConflictRule } from '../../../../src/comms/ceremony-triggers/code-conflict.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('codeConflictRule', () => {
  it('fires when two ready tasks share write paths', async () => {
    const db = new SqlMockingDb().on(['ready_tasks', 'INTERSECT'], [
      {
        task_a: 'task-a',
        task_b: 'task-b',
        persona_a: 'p-1',
        persona_b: 'p-2',
        shared: ['src/api.ts'],
      },
    ])
    const env = makeEnvelope({
      event_type: 'SchedulerTick',
      aggregate_type: 'orchestration',
      aggregate_id: 'install-1',
    })
    const spec = await codeConflictRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('code_conflict_resolution')
    expect(spec?.scope['shared_paths']).toEqual(['src/api.ts'])
    expect(spec?.invitedRoles).toEqual(expect.arrayContaining(['p-1', 'p-2']))
  })

  it('does not fire when there are no overlapping ready tasks', async () => {
    const db = new SqlMockingDb().on(['ready_tasks', 'INTERSECT'], [])
    const env = makeEnvelope({ event_type: 'SchedulerTick' })
    const spec = await codeConflictRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares SchedulerTick as its trigger', () => {
    expect(codeConflictRule.triggers).toEqual(['SchedulerTick'])
  })
})
