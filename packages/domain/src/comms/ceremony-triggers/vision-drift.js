/**
 * vision-drift rule.
 *
 * Fires on: RetroProposed
 *
 * Match condition: >=3 proposals with target_layer='vision' in the last
 * window of retros (we use the last 90 days as the window proxy). The
 * retro_proposal_layers table carries the dominant layer per proposal; we
 * count proposals whose dominant layer is 'vision'.
 *
 * Spec: invite PM + Architect + retro analyst.
 */
import { sql as dSQL } from 'drizzle-orm';
const RULE_ID = 'vision-drift';
const VISION_PROPOSAL_THRESHOLD = 3;
const WINDOW_DAYS = 90;
export const visionDriftRule = {
    id: RULE_ID,
    description: 'Schedule a vision drift review when >=3 retro proposals target the vision layer in 90 days',
    triggers: ['RetroProposed'],
    async match(_envelope, ctx) {
        const rows = await ctx.db.execute(dSQL `
      SELECT COUNT(DISTINCT rp.retro_proposal_id)::int AS count
      FROM retro_proposals rp
      JOIN retro_proposal_layers rpl
        ON rpl.retro_proposal_id = rp.retro_proposal_id
       AND rpl.is_dominant = true
       AND rpl.layer = 'vision'
      WHERE rp.created_at > now() - interval '90 days'
    `);
        const count = Number(rows[0]?.count ?? 0);
        if (count < VISION_PROPOSAL_THRESHOLD)
            return null;
        return {
            ceremonyType: 'ad_hoc',
            scope: {
                intent: 'vision_drift_review',
                vision_targeted_proposals: count,
                window_days: WINDOW_DAYS,
            },
            triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
            invitedRoles: ['pm', 'architect', 'retro_analyst'],
        };
    },
};
//# sourceMappingURL=vision-drift.js.map