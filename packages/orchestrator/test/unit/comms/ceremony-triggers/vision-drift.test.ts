import { describe, it, expect } from 'vitest'
import { visionDriftRule } from '../../../../src/comms/ceremony-triggers/vision-drift.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('visionDriftRule', () => {
  it('fires when >=3 vision-targeted retro proposals exist in the window', async () => {
    const db = new SqlMockingDb().on(['retro_proposals', "layer = 'vision'"], [
      { count: 4 },
    ])
    const env = makeEnvelope({
      event_type: 'RetroProposed',
      aggregate_type: 'retro',
      aggregate_id: 'rp-latest',
    })
    const spec = await visionDriftRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('vision_drift_review')
    expect(spec?.scope['vision_targeted_proposals']).toBe(4)
    expect(spec?.invitedRoles).toEqual(['pm', 'architect', 'retro_analyst'])
  })

  it('does not fire when below the threshold', async () => {
    const db = new SqlMockingDb().on(['retro_proposals', "layer = 'vision'"], [
      { count: 1 },
    ])
    const env = makeEnvelope({ event_type: 'RetroProposed' })
    const spec = await visionDriftRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(visionDriftRule.triggers).toEqual(['RetroProposed'])
  })
})
