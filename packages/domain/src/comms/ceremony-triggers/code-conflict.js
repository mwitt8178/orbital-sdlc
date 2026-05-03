/**
 * code-conflict rule.
 *
 * Fires on: SchedulerTick (synthetic event emitted by Scheduler at tick start).
 *
 * Match condition: two ready tasks have overlapping `declared_write_paths`
 * (the file globs the persona declared at task-creation time). This is the
 * static analog of the Scheduler.feasible() runtime check — surfacing a
 * conflict before either task is allocated lets a ceremony resolve who owns
 * the path.
 *
 * Spec: invite the persona-of-record from each conflicting task.
 */
import { sql as dSQL } from 'drizzle-orm';
const RULE_ID = 'code-conflict';
export const codeConflictRule = {
    id: RULE_ID,
    description: 'Schedule a path-ownership ceremony when two ready tasks have overlapping declared write paths',
    triggers: ['SchedulerTick'],
    async match(_envelope, ctx) {
        // Find at most one pair of ready tasks with overlapping write paths.
        // We use jsonb && (array overlap) on the declared_write_paths column.
        const rows = await ctx.db.execute(dSQL `
      WITH ready_tasks AS (
        SELECT task_id, persona_id, declared_write_paths
        FROM tasks
        WHERE state = 'ready'
          AND jsonb_array_length(declared_write_paths) > 0
      )
      SELECT
        a.task_id AS task_a,
        b.task_id AS task_b,
        a.persona_id AS persona_a,
        b.persona_id AS persona_b,
        ARRAY(
          SELECT jsonb_array_elements_text(a.declared_write_paths)
          INTERSECT
          SELECT jsonb_array_elements_text(b.declared_write_paths)
        ) AS shared
      FROM ready_tasks a
      JOIN ready_tasks b ON b.task_id > a.task_id
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(a.declared_write_paths) AS pa
        WHERE pa IN (
          SELECT jsonb_array_elements_text(b.declared_write_paths)
        )
      )
      LIMIT 1
    `);
        const arr = rows;
        const conflict = arr[0];
        if (!conflict)
            return null;
        return {
            ceremonyType: 'ad_hoc',
            scope: {
                intent: 'code_conflict_resolution',
                task_a: conflict.task_a,
                task_b: conflict.task_b,
                shared_paths: conflict.shared ?? [],
            },
            triggeredBy: { type: 'system', component: 'ceremony_scheduler' },
            invitedRoles: [conflict.persona_a, conflict.persona_b].filter((v, i, a) => a.indexOf(v) === i),
        };
    },
};
//# sourceMappingURL=code-conflict.js.map