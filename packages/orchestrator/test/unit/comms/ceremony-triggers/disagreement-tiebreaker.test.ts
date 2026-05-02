import { describe, it, expect } from 'vitest'
import { disagreementTiebreakerRule } from '../../../../src/comms/ceremony-triggers/disagreement-tiebreaker.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('disagreementTiebreakerRule', () => {
  it('fires on DisagreementRaised with a technical domain and invites architect', async () => {
    const env = makeEnvelope({
      event_type: 'DisagreementRaised',
      aggregate_type: 'disagreement',
      aggregate_id: 'd-1',
      payload: {
        disagreement_id: 'd-1',
        domain: 'technical',
        participants: [
          { actor: { type: 'persona', persona_id: 'p-1' }, position_summary: 'A' },
          { actor: { type: 'persona', persona_id: 'p-2' }, position_summary: 'B' },
        ],
      },
    })
    const spec = await disagreementTiebreakerRule.match(env, makeContext(new SqlMockingDb()))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('tie_breaker')
    expect(spec?.scope['disagreement_id']).toBe('d-1')
    expect(spec?.invitedRoles).toContain('architect')
    expect(spec?.invitedRoles).toContain('p-1')
    expect(spec?.invitedRoles).toContain('p-2')
  })

  it('uses pm for product-domain disagreements', async () => {
    const env = makeEnvelope({
      event_type: 'DisagreementRaised',
      payload: { disagreement_id: 'd-2', domain: 'product', participants: [] },
    })
    const spec = await disagreementTiebreakerRule.match(env, makeContext(new SqlMockingDb()))
    expect(spec?.invitedRoles[0]).toBe('pm')
  })

  it('declares correct triggers', () => {
    expect(disagreementTiebreakerRule.triggers).toEqual(['DisagreementRaised'])
  })
})
