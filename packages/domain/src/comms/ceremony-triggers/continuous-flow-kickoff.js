/**
 * continuous-flow-kickoff rule.
 *
 * Fires on: SprintCompleted
 *
 * Match condition: backlog has >=1 ready story AND no other planning sprint
 * exists. The auto-pilot for continuous-flow teams: when a sprint finishes and
 * there's work to do, queue the next planning sprint immediately.
 *
 * NOTE: This rule does NOT auto-create the next sprint here — that requires
 * SprintService and is a stateful side-effect that should be orchestrated by a
 * dedicated planning agent or operator. Instead, this rule schedules an
 * `ad_hoc` ceremony with `intent='continuous_flow_kickoff'` so the
 * scrum_master persona (or the UI) can confirm and create the sprint. This
 * preserves the "scheduler is a producer of ceremonies, not a peer of stateful
 * services" boundary and keeps multi-tenant safety.
 *
 * Spec: invite Scrum Master + PM. Scope flags `requires_sprint_creation=true`
 * so downstream consumers know to create a planning sprint as the ceremony's
 * first action.
 */
import { sql as dSQL } from 'drizzle-orm';
const RULE_ID = 'continuous-flow-kickoff';
export const continuousFlowKickoffRule = {
    id: RULE_ID,
    description: 'Auto-spawn a kickoff ceremony when a sprint completes, work is ready, and no planning sprint exists',
    triggers: ['SprintCompleted'],
    async match(envelope, ctx) {
        const completedSprintId = envelope.aggregate_id;
        const planningCountRows = await ctx.db.execute(dSQL `
      SELECT COUNT(*)::int AS count FROM sprints WHERE status = 'planning'
    `);
        const planningCount = Number(planningCountRows[0]?.count ?? 0);
        if (planningCount > 0)
            return null;
        const readyRows = await ctx.db.execute(dSQL `
      SELECT COUNT(*)::int AS count FROM stories WHERE status = 'ready'
    `);
        const readyCount = Number(readyRows[0]?.count ?? 0);
        if (readyCount < 1)
            return null;
        return {
            ceremonyType: 'ad_hoc',
            scope: {
                intent: 'continuous_flow_kickoff',
                completed_sprint_id: completedSprintId,
                ready_story_count: readyCount,
                requires_sprint_creation: true,
            },
            triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
            invitedRoles: ['scrum_master', 'pm'],
        };
    },
};
//# sourceMappingURL=continuous-flow-kickoff.js.map