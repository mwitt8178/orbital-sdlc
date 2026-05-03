/**
 * budget-review rule.
 *
 * Fires on: BudgetWarning (emitted by routing/cost.ts when consumption crosses
 * the warning_threshold_pct).
 *
 * Spec: invite EM + Scrum Master.
 */

import type { EventEnvelope } from '@orbital/types'
import type { CeremonySpec, CeremonyTriggerRule, TriggerContext } from '../ceremony-scheduler.js'

const RULE_ID = 'budget-review'

export const budgetReviewRule: CeremonyTriggerRule = {
  id: RULE_ID,
  description: 'Schedule a budget review ceremony on BudgetWarning',
  triggers: ['BudgetWarning'],

  async match(envelope: EventEnvelope, _ctx: TriggerContext): Promise<CeremonySpec | null> {
    const payload = envelope.payload as Record<string, unknown>
    const scope = payload['scope'] as string | undefined
    const scopeKey = payload['scope_key'] as string | undefined
    const pctConsumed = Number(payload['pct_consumed'] ?? 0)
    const thresholdPct = Number(payload['threshold_pct'] ?? 0)

    return {
      ceremonyType: 'ad_hoc',
      scope: {
        intent: 'budget_review',
        budget_scope: scope ?? 'unknown',
        scope_key: scopeKey ?? envelope.aggregate_id,
        pct_consumed: pctConsumed,
        threshold_pct: thresholdPct,
      },
      triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
      invitedRoles: ['engineering_manager', 'scrum_master'],
    }
  },
}
