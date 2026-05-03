/**
 * security-review rule.
 *
 * Fires on: CapabilityDenied
 *
 * Match condition: >=5 denials in the last 60 minutes (across the install).
 * The query uses the audit.events table so the count includes the triggering
 * event itself.
 *
 * Spec: invite Security persona + the offending workers (the personas named
 * in the most recent denials).
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const securityReviewRule: CeremonyTriggerRule;
//# sourceMappingURL=security-review.d.ts.map