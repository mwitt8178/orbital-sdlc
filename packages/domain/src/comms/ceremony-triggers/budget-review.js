/**
 * budget-review rule.
 *
 * Fires on: BudgetWarning (emitted by routing/cost.ts when consumption crosses
 * the warning_threshold_pct).
 *
 * Spec: invite EM + Scrum Master.
 */
const RULE_ID = 'budget-review';
export const budgetReviewRule = {
    id: RULE_ID,
    description: 'Schedule a budget review ceremony on BudgetWarning',
    triggers: ['BudgetWarning'],
    async match(envelope, _ctx) {
        const payload = envelope.payload;
        const scope = payload['scope'];
        const scopeKey = payload['scope_key'];
        const pctConsumed = Number(payload['pct_consumed'] ?? 0);
        const thresholdPct = Number(payload['threshold_pct'] ?? 0);
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
        };
    },
};
//# sourceMappingURL=budget-review.js.map