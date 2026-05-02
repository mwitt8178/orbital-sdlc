import { describe, it, expect } from 'vitest'
import { midSprintDeviationRule } from '../../../../src/comms/ceremony-triggers/mid-sprint-deviation.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('midSprintDeviationRule', () => {
  it('fires when elapsed > 50% and completed < 30% on an active sprint', async () => {
    const db = new SqlMockingDb().on(['FROM sprints', 'WHERE sprint_id'], [
      { status: 'active' },
    ])
    const env = makeEnvelope({
      event_type: 'SprintProgressEvaluated',
      aggregate_type: 'sprint',
      aggregate_id: 'sprint-1',
      payload: { elapsed_pct: 60, completed_task_pct: 20 },
    })
    const spec = await midSprintDeviationRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('async_standup')
    expect(spec?.scope['sprint_id']).toBe('sprint-1')
    expect(spec?.invitedRoles).toContain('scrum_master')
  })

  it('does not fire when elapsed is below 50%', async () => {
    const db = new SqlMockingDb()
    const env = makeEnvelope({
      event_type: 'SprintProgressEvaluated',
      payload: { elapsed_pct: 40, completed_task_pct: 20 },
    })
    const spec = await midSprintDeviationRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('does not fire when sprint is not active', async () => {
    const db = new SqlMockingDb().on(['FROM sprints', 'WHERE sprint_id'], [
      { status: 'completed' },
    ])
    const env = makeEnvelope({
      event_type: 'SprintProgressEvaluated',
      payload: { elapsed_pct: 70, completed_task_pct: 10 },
    })
    const spec = await midSprintDeviationRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(midSprintDeviationRule.triggers).toEqual(['SprintProgressEvaluated'])
  })
})
