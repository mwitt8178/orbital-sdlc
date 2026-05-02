import { describe, it, expect } from 'vitest'
import { backlogGroomingRule } from '../../../../src/comms/ceremony-triggers/backlog-grooming.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('backlogGroomingRule', () => {
  it('fires when ready_story_count is below 1.5x capacity', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'planning'], [{ cap: 20 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 5 }]) // 5 < 1.5 * 20 = 30
      .on(['FROM stories s', "status = 'backlog'"], [{ count: 0 }])

    const env = makeEnvelope({ event_type: 'SprintCompleted' })
    const spec = await backlogGroomingRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('backlog_grooming')
    expect(spec?.invitedRoles).toEqual(['pm', 'architect'])
    expect(spec?.scope['reason']).toBe('low_ready_count')
  })

  it('fires when more than 5 stories are ungroomed even if ready count is healthy', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'planning'], [{ cap: 10 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 100 }])
      .on(['FROM stories s', "status = 'backlog'"], [{ count: 6 }])

    const env = makeEnvelope({ event_type: 'StoryCreated', aggregate_type: 'story' })
    const spec = await backlogGroomingRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.scope['reason']).toBe('too_many_ungroomed')
  })

  it('does not fire when backlog is healthy', async () => {
    const db = new SqlMockingDb()
      .on(['FROM sprints', 'planning'], [{ cap: 10 }])
      .on(['FROM stories', "status = 'ready'"], [{ count: 50 }])
      .on(['FROM stories s', "status = 'backlog'"], [{ count: 0 }])

    const env = makeEnvelope({ event_type: 'SprintCompleted' })
    const spec = await backlogGroomingRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(backlogGroomingRule.triggers).toEqual(['SprintCompleted', 'StoryCreated'])
  })
})
