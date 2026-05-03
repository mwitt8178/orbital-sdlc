/**
 * sprint-review rule.
 *
 * Fires on: SprintCompleting (intent: a sprint is about to close — use the
 * sprint_retrospective ceremony type to gather PM + EM + active workers).
 *
 * NOTE: Many sprints transition straight to 'completed' without an explicit
 * 'completing' state. We accept either `SprintCompleting` (preferred) or
 * `SprintCompleted` events; for the latter we skip if the sibling
 * continuous-flow-kickoff already fired (different rule, same trigger event).
 *
 * Spec: invite PM + EM (scrum master is implicit chair via spec).
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const sprintReviewRule: CeremonyTriggerRule;
//# sourceMappingURL=sprint-review.d.ts.map