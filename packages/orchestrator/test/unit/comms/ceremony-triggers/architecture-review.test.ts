import { describe, it, expect } from 'vitest'
import { architectureReviewRule } from '../../../../src/comms/ceremony-triggers/architecture-review.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('architectureReviewRule', () => {
  it('fires when a high-risk story transitions to ready', async () => {
    const storyId = 'story-1'
    const db = new SqlMockingDb().on(['FROM stories', 'WHERE story_id'], [
      {
        story_id: storyId,
        title: 'Multi-tenant migration',
        linked_artifacts: [{ type: 'risk', id: 'high' }],
      },
    ])
    const env = makeEnvelope({
      event_type: 'StoryStatusChanged',
      aggregate_type: 'story',
      aggregate_id: storyId,
      payload: { story_id: storyId, new_status: 'ready', old_status: 'backlog' },
    })
    const spec = await architectureReviewRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('architecture_review')
    expect(spec?.scope['story_id']).toBe(storyId)
    expect(spec?.invitedRoles).toEqual(['architect', 'senior_developer'])
  })

  it('does not fire when the story is not high-risk', async () => {
    const db = new SqlMockingDb().on(['FROM stories', 'WHERE story_id'], [
      { story_id: 's', title: 'Normal', linked_artifacts: [] },
    ])
    const env = makeEnvelope({
      event_type: 'StoryStatusChanged',
      payload: { story_id: 's', new_status: 'ready' },
    })
    const spec = await architectureReviewRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('does not fire when the new_status is not ready', async () => {
    const db = new SqlMockingDb()
    const env = makeEnvelope({
      event_type: 'StoryStatusChanged',
      payload: { story_id: 's', new_status: 'in_progress' },
    })
    const spec = await architectureReviewRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(architectureReviewRule.triggers).toEqual(['StoryStatusChanged'])
  })
})
