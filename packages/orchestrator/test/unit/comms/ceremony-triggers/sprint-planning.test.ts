import { describe, it, expect } from 'vitest'
import { sprintPlanningRule } from '../../../../src/comms/ceremony-triggers/sprint-planning.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('sprintPlanningRule', () => {
  it('fires when a planning sprint has enough ready stories to fill capacity', async () => {
    const sprintId = 'sprint-uuid-1'
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'WHERE sprint_id'], [
        { sprint_id: sprintId, status: 'planning', story_point_capacity: 30 },
      ])
      .on(['FROM stories', "status = 'ready'"], [{ total: 35 }])

    const env = makeEnvelope({
      event_type: 'SprintCreated',
      aggregate_type: 'sprint',
      aggregate_id: sprintId,
    })
    const spec = await sprintPlanningRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('sprint_planning')
    expect(spec?.invitedRoles).toEqual(['pm', 'architect', 'senior_developer'])
    expect(spec?.scope['sprint_id']).toBe(sprintId)
    expect(spec?.scope['ready_story_points_available']).toBe(35)
  })

  it('does not fire when there are not enough ready stories', async () => {
    const sprintId = 'sprint-uuid-2'
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'WHERE sprint_id'], [
        { sprint_id: sprintId, status: 'planning', story_point_capacity: 30 },
      ])
      .on(['FROM stories', "status = 'ready'"], [{ total: 10 }])

    const env = makeEnvelope({
      event_type: 'SprintCreated',
      aggregate_type: 'sprint',
      aggregate_id: sprintId,
    })
    const spec = await sprintPlanningRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('does not fire when sprint is not in planning state', async () => {
    const db = new SqlMockingDb().on(['FROM sprints', 'WHERE sprint_id'], [
      { sprint_id: 'x', status: 'active', story_point_capacity: 10 },
    ])
    const env = makeEnvelope({
      event_type: 'SprintCreated',
      aggregate_type: 'sprint',
      aggregate_id: 'x',
    })
    const spec = await sprintPlanningRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(sprintPlanningRule.triggers).toEqual(['SprintCreated'])
  })
})
