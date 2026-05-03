/**
 * backlog-grooming rule.
 *
 * Fires on:
 *   - SprintCompleted (the trailing wake-up)
 *   - StoryCreated (new work landing)
 *
 * Match condition:
 *   ready_story_count < 1.5 * next_planning_sprint_capacity
 *   OR ungroomed_story_count > 5 (stories with no ACs OR no estimate)
 *
 * Spec: invite PM + Architect for backlog grooming.
 */
import { sql as dSQL } from 'drizzle-orm';
const RULE_ID = 'backlog-grooming';
export const backlogGroomingRule = {
    id: RULE_ID,
    description: 'Schedule backlog grooming when ready stories run low or many stories are ungroomed',
    triggers: ['SprintCompleted', 'StoryCreated'],
    async match(_envelope, ctx) {
        // Capacity proxy: take the largest planning sprint's capacity, fallback to
        // the most recent ready/active sprint, fallback to 20 (a sensible default).
        const capacityRows = await ctx.db.execute(dSQL `
      SELECT story_point_capacity AS cap
      FROM sprints
      WHERE status IN ('planning', 'ready', 'active')
      ORDER BY sequence DESC
      LIMIT 1
    `);
        const capRows = capacityRows;
        const capacity = Number(capRows[0]?.cap ?? 20);
        // ready_story_count: stories in 'ready' status.
        const readyRows = await ctx.db.execute(dSQL `
      SELECT COUNT(*)::int AS count FROM stories WHERE status = 'ready'
    `);
        const readyCount = Number(readyRows[0]?.count ?? 0);
        // ungroomed_story_count: backlog stories with no ACs OR no estimate.
        const ungroomedRows = await ctx.db.execute(dSQL `
      SELECT COUNT(*)::int AS count
      FROM stories s
      WHERE s.status = 'backlog'
        AND (
          s.story_points IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM story_acceptance_criteria ac WHERE ac.story_id = s.story_id
          )
        )
    `);
        const ungroomedCount = Number(ungroomedRows[0]?.count ?? 0);
        const lowReady = readyCount < 1.5 * capacity;
        const tooManyUngroomed = ungroomedCount > 5;
        if (!lowReady && !tooManyUngroomed)
            return null;
        return {
            ceremonyType: 'backlog_grooming',
            scope: {
                ready_story_count: readyCount,
                ungroomed_story_count: ungroomedCount,
                capacity,
                reason: lowReady ? 'low_ready_count' : 'too_many_ungroomed',
            },
            triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
            invitedRoles: ['pm', 'architect'],
        };
    },
};
//# sourceMappingURL=backlog-grooming.js.map