/**
 * sprint-planning rule.
 *
 * Fires on: SprintCreated (with state=planning)
 *
 * Match condition: backlog has enough ready stories to fill
 * sprint.story_point_capacity. The check is: SUM(story_points) of ready
 * stories >= sprint.story_point_capacity.
 *
 * Spec: invite PM + Architect + Senior Developer for the planning ceremony,
 * scoped to the new sprint id.
 */
import { sql as dSQL } from 'drizzle-orm';
const RULE_ID = 'sprint-planning';
export const sprintPlanningRule = {
    id: RULE_ID,
    description: 'Schedule sprint planning when a new planning sprint has enough ready stories',
    triggers: ['SprintCreated'],
    async match(envelope, ctx) {
        const sprintId = envelope.aggregate_id;
        const sprintRows = await ctx.db.execute(dSQL `
      SELECT sprint_id, status, story_point_capacity
      FROM sprints
      WHERE sprint_id = ${sprintId}
      LIMIT 1
    `);
        const sprintArr = sprintRows;
        const sprint = sprintArr[0];
        if (!sprint)
            return null;
        if (sprint.status !== 'planning')
            return null;
        const capacity = Number(sprint.story_point_capacity);
        const readySumRows = await ctx.db.execute(dSQL `
      SELECT COALESCE(SUM(story_points), 0)::int AS total
      FROM stories
      WHERE status = 'ready' AND story_points IS NOT NULL
    `);
        const totalReadyPoints = Number(readySumRows[0]?.total ?? 0);
        if (totalReadyPoints < capacity)
            return null;
        return {
            ceremonyType: 'sprint_planning',
            scope: {
                sprint_id: sprintId,
                story_point_capacity: capacity,
                ready_story_points_available: totalReadyPoints,
            },
            triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
            invitedRoles: ['pm', 'architect', 'senior_developer'],
        };
    },
};
//# sourceMappingURL=sprint-planning.js.map