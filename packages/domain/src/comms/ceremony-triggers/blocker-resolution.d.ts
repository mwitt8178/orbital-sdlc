/**
 * blocker-resolution rule.
 *
 * Fires on: BlockerRaised
 *
 * Match condition: blocker has been open >= 30 min wallclock without progress
 * (i.e., still in 'raised' state with no routing or resolution). The rule
 * inspects the blockers table to confirm.
 *
 * Note: this rule fires the first time a stale blocker is observed. The 30-min
 * staleness check fires *only* when the rule sees the BlockerRaised event
 * after enough time has passed. In practice, BlockerRaised arrives immediately;
 * if the blocker is still 'raised' after 30 min it has been routed/escalated
 * by then OR the routing has stalled (the case we care about). We therefore
 * gate with: state still 'raised' AND raised_at < now() - 30 min.
 *
 * Spec: invite the requested resolver role + the raising worker.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const blockerResolutionRule: CeremonyTriggerRule;
//# sourceMappingURL=blocker-resolution.d.ts.map