/**
 * ceremony-triggers/index.ts — registry of every ceremony trigger rule.
 *
 * The 12 rules in `defaultRules` cover the full agent-native ceremony coverage
 * map (TRD-05 §6.2.6). Each rule is a small, focused module that:
 *   - declares the event_types that wake it (cheap pre-filter)
 *   - performs ONE state check
 *   - returns ONE CeremonySpec or null
 *
 * The CeremonyScheduler subscribes to the EventStore once and dispatches each
 * envelope through the rules whose `triggers` include the event_type.
 *
 * To add a new rule:
 *   1. Create a new file in this directory with the same shape
 *   2. Import + append to defaultRules
 *   3. Add a unit test that drives the rule with a synthetic envelope
 */

import type { CeremonyTriggerRule } from '../ceremony-scheduler.js'
import { backlogGroomingRule } from './backlog-grooming.js'
import { sprintPlanningRule } from './sprint-planning.js'
import { continuousFlowKickoffRule } from './continuous-flow-kickoff.js'
import { midSprintDeviationRule } from './mid-sprint-deviation.js'
import { sprintReviewRule } from './sprint-review.js'
import { disagreementTiebreakerRule } from './disagreement-tiebreaker.js'
import { blockerResolutionRule } from './blocker-resolution.js'
import { architectureReviewRule } from './architecture-review.js'
import { codeConflictRule } from './code-conflict.js'
import { budgetReviewRule } from './budget-review.js'
import { securityReviewRule } from './security-review.js'
import { visionDriftRule } from './vision-drift.js'

export const defaultRules: CeremonyTriggerRule[] = [
  backlogGroomingRule,
  sprintPlanningRule,
  continuousFlowKickoffRule,
  midSprintDeviationRule,
  sprintReviewRule,
  disagreementTiebreakerRule,
  blockerResolutionRule,
  architectureReviewRule,
  codeConflictRule,
  budgetReviewRule,
  securityReviewRule,
  visionDriftRule,
]

export {
  backlogGroomingRule,
  sprintPlanningRule,
  continuousFlowKickoffRule,
  midSprintDeviationRule,
  sprintReviewRule,
  disagreementTiebreakerRule,
  blockerResolutionRule,
  architectureReviewRule,
  codeConflictRule,
  budgetReviewRule,
  securityReviewRule,
  visionDriftRule,
}
