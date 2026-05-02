import { describe, it, expect } from 'vitest'
import { securityReviewRule } from '../../../../src/comms/ceremony-triggers/security-review.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('securityReviewRule', () => {
  it('fires when >=5 denials occur within 60 minutes', async () => {
    const db = new SqlMockingDb()
      .on(['SELECT COUNT(*)::int AS total', 'CapabilityDenied'], [{ total: 7 }])
      .on(['GROUP BY persona_id'], [
        { persona_id: 'p-bad', denials: 5 },
        { persona_id: 'p-other', denials: 2 },
      ])
    const env = makeEnvelope({
      event_type: 'CapabilityDenied',
      aggregate_type: 'capability',
      aggregate_id: 'cap-1',
    })
    const spec = await securityReviewRule.match(env, makeContext(db))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('security_review')
    expect(spec?.scope['denials_in_window']).toBe(7)
    expect(spec?.invitedRoles).toContain('security_officer')
    expect(spec?.invitedRoles).toContain('p-bad')
  })

  it('does not fire when below the threshold', async () => {
    const db = new SqlMockingDb().on(
      ['SELECT COUNT(*)::int AS total', 'CapabilityDenied'],
      [{ total: 2 }],
    )
    const env = makeEnvelope({ event_type: 'CapabilityDenied' })
    const spec = await securityReviewRule.match(env, makeContext(db))
    expect(spec).toBeNull()
  })

  it('declares correct triggers', () => {
    expect(securityReviewRule.triggers).toEqual(['CapabilityDenied'])
  })
})
