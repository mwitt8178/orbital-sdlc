/**
 * disagreement-tiebreaker rule.
 *
 * Fires on: DisagreementRaised
 *
 * ConflictService raises the event; this rule auto-spawns the tie-breaker
 * ceremony with the disputants. The tie-breaker role per domain is encoded
 * in TieBreakerPolicy (technical -> architect, product -> pm, etc.) — we
 * mirror that mapping here so the invited_roles hint is correct without
 * importing ConflictService internals.
 *
 * Spec: invite the tie-breaker persona + the actors named in the
 * DisagreementRaised payload.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const disagreementTiebreakerRule: CeremonyTriggerRule;
//# sourceMappingURL=disagreement-tiebreaker.d.ts.map