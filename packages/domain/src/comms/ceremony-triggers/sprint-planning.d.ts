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
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const sprintPlanningRule: CeremonyTriggerRule;
//# sourceMappingURL=sprint-planning.d.ts.map