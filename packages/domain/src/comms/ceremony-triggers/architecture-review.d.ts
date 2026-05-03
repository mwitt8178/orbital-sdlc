/**
 * architecture-review rule.
 *
 * Fires on: StoryStatusChanged (transition to 'ready')
 *
 * Match condition: story.risk_class == 'high'. The story-level risk_class is
 * derived from the linked epic and any explicit override carried on the
 * acceptance criteria; for v1 we read it via the story's monday/linked
 * artifacts, falling back to a heuristic on the description for stories
 * whose risk_class column hasn't been provisioned yet (story_acceptance
 * decisions are still wired in TRD-02 v0.3). Until the column exists, we
 * inspect linked_artifacts for { type: 'risk', id: 'high' }.
 *
 * Spec: invite Architect + Senior Developer.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const architectureReviewRule: CeremonyTriggerRule;
//# sourceMappingURL=architecture-review.d.ts.map