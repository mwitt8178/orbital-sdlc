import { describe, it, expect } from 'vitest'
import { sprintReviewRule } from '../../../../src/comms/ceremony-triggers/sprint-review.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('sprintReviewRule', () => {
  it('fires on SprintCompleting and includes active worker personas', async () => {
    const sprintId = 'sprint-rev-1'
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'WHERE sprint_id'], [
        { sprint_id: sprintId, status: 'completing' },
      ])
      .on(['FROM tasks', 'WHERE sprint_id'], [
        { persona_id: 'p-eng-1' },
        { persona_id: 'p-eng-2' },
      ])
    const env = makeEnvelope({
      event_type: 'SprintCompleting',
      aggregate_type: 'sprint',
      aggregate_id: sprintId,
    })
    const spec = await sprintReviewRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('sprint_retrospective')
    expect(spec?.scope['sprint_id']).toBe(sprintId)
    expect(spec?.scope['active_worker_personas']).toEqual(['p-eng-1', 'p-eng-2'])
    expect(spec?.invitedRoles).toEqual(['pm', 'engineering_manager', 'scrum_master'])
  })

  it('returns null when sprint does not exist', async () => {
    const db = new SqlMockingDb().on(['FROM sprints', 'WHERE sprint_id'], [])
    const env = makeEnvelope({
      event_type: 'SprintCompleting',
      aggregate_type: 'sprint',
      aggregate_id: 'missing',
    })
    const spec = await sprintReviewRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares both completing and completed as triggers', () => {
    expect(sprintReviewRule.triggers).toEqual(['SprintCompleting', 'SprintCompleted'])
  })
})
