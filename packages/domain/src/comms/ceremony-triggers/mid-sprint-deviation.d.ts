/**
 * mid-sprint-deviation rule.
 *
 * Fires on: SprintProgressEvaluated (synthetic event emitted by Scheduler)
 *
 * Match condition: sprint.elapsed > 50% wallclock AND completed_tasks < 30%
 * total. The synthetic event payload carries the metrics so this rule does
 * not have to recompute progress.
 *
 * Spec: schedule an async_standup with the Scrum Master + active workers.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const midSprintDeviationRule: CeremonyTriggerRule;
//# sourceMappingURL=mid-sprint-deviation.d.ts.map