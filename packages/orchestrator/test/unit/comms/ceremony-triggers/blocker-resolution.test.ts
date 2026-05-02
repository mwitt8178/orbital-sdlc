import { describe, it, expect } from 'vitest'
import { blockerResolutionRule } from '../../../../src/comms/ceremony-triggers/blocker-resolution.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('blockerResolutionRule', () => {
  it('fires when a stale blocker (>=30 min, still raised) is observed', async () => {
    const blockerId = 'blk-1'
    const db = new SqlMockingDb().on(['FROM blockers', 'WHERE blocker_id'], [
      {
        blocker_id: blockerId,
        state: 'raised',
        requested_resolver_role: 'architect',
        raising_actor: { type: 'persona', persona_id: 'p-raiser' },
        raising_task_id: 'task-1',
      },
    ])
    const env = makeEnvelope({
      event_type: 'BlockerRaised',
      aggregate_type: 'task',
      aggregate_id: 'task-1',
      payload: { blocker_id: blockerId },
    })
    const spec = await blockerResolutionRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('blocker_resolution')
    expect(spec?.scope['blocker_id']).toBe(blockerId)
    expect(spec?.invitedRoles).toContain('architect')
    expect(spec?.invitedRoles).toContain('p-raiser')
  })

  it('does not fire when the blocker is fresh (still under 30 min)', async () => {
    const db = new SqlMockingDb().on(['FROM blockers', 'WHERE blocker_id'], [])
    const env = makeEnvelope({
      event_type: 'BlockerRaised',
      payload: { blocker_id: 'b-fresh' },
    })
    const spec = await blockerResolutionRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('returns null when payload has no blocker_id', async () => {
    const env = makeEnvelope({ event_type: 'BlockerRaised', payload: {} })
    const spec = await blockerResolutionRule.match(env, makeContext(new SqlMockingDb()))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(blockerResolutionRule.triggers).toEqual(['BlockerRaised'])
  })
})
