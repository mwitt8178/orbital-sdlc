import { describe, it, expect } from 'vitest'
import { budgetReviewRule } from '../../../../src/comms/ceremony-triggers/budget-review.js'
import { SqlMockingDb, makeEnvelope, makeContext } from './test-helpers.js'

describe('budgetReviewRule', () => {
  it('fires on every BudgetWarning', async () => {
    const env = makeEnvelope({
      event_type: 'BudgetWarning',
      aggregate_type: 'sprint',
      aggregate_id: 'sprint-x',
      payload: {
        cap_id: 'cap-1',
        scope: 'sprint',
        scope_key: 'sprint-x',
        pct_consumed: 80,
        threshold_pct: 75,
      },
    })
    const spec = await budgetReviewRule.match(env, makeContext(new SqlMockingDb()))
    expect(spec).not.toBeNull()
    expect(spec?.ceremonyType).toBe('ad_hoc')
    expect(spec?.scope['intent']).toBe('budget_review')
    expect(spec?.scope['budget_scope']).toBe('sprint')
    expect(spec?.scope['pct_consumed']).toBe(80)
    expect(spec?.invitedRoles).toEqual(['engineering_manager', 'scrum_master'])
  })

  it('declares correct triggers', () => {
    expect(budgetReviewRule.triggers).toEqual(['BudgetWarning'])
  })
})
