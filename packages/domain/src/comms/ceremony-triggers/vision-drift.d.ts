/**
 * vision-drift rule.
 *
 * Fires on: RetroProposed
 *
 * Match condition: >=3 proposals with target_layer='vision' in the last
 * window of retros (we use the last 90 days as the window proxy). The
 * retro_proposal_layers table carries the dominant layer per proposal; we
 * count proposals whose dominant layer is 'vision'.
 *
 * Spec: invite PM + Architect + retro analyst.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const visionDriftRule: CeremonyTriggerRule;
//# sourceMappingURL=vision-drift.d.ts.map