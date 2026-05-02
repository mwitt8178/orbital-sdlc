import { describe, it, expect } from 'vitest'
import { continuousFlowKickoffRule } from '../../../../src/comms/ceremony-triggers/continuous-flow-kickoff.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('continuousFlowKickoffRule', () => {
  it('fires when no planning sprint exists and there is ready work', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', "status = 'planning'"], [{ count: 0 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 3 }])

    const env = makeEnvelope({
      event_type: 'SprintCompleted',
      aggregate_type: 'sprint',
      aggregate_id: 'sprint-completed',
    })
    const spec = await continuousFlowKickoffRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('continuous_flow_kickoff')
    expect(spec?.scope['completed_sprint_id']).toBe('sprint-completed')
    expect(spec?.scope['requires_sprint_creation']).toBe(true)
    expect(spec?.invitedRoles).toEqual(['scrum_master', 'pm'])
  })

  it('does not fire when a planning sprint already exists', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', "status = 'planning'"], [{ count: 1 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 5 }])

    const env = makeEnvelope({ event_type: 'SprintCompleted' })
    const spec = await continuousFlowKickoffRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('does not fire when there are no ready stories', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', "status = 'planning'"], [{ count: 0 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 0 }])

    const env = makeEnvelope({ event_type: 'SprintCompleted' })
    const spec = await continuousFlowKickoffRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(continuousFlowKickoffRule.triggers).toEqual(['SprintCompleted'])
  })
})
