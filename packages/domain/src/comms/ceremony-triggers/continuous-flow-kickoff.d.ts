/**
 * continuous-flow-kickoff rule.
 *
 * Fires on: SprintCompleted
 *
 * Match condition: backlog has >=1 ready story AND no other planning sprint
 * exists. The auto-pilot for continuous-flow teams: when a sprint finishes and
 * there's work to do, queue the next planning sprint immediately.
 *
 * NOTE: This rule does NOT auto-create the next sprint here — that requires
 * SprintService and is a stateful side-effect that should be orchestrated by a
 * dedicated planning agent or operator. Instead, this rule schedules an
 * `ad_hoc` ceremony with `intent='continuous_flow_kickoff'` so the
 * scrum_master persona (or the UI) can confirm and create the sprint. This
 * preserves the "scheduler is a producer of ceremonies, not a peer of stateful
 * services" boundary and keeps multi-tenant safety.
 *
 * Spec: invite Scrum Master + PM. Scope flags `requires_sprint_creation=true`
 * so downstream consumers know to create a planning sprint as the ceremony's
 * first action.
 */
import type { CeremonyTriggerRule } from '../ceremony-scheduler.js';
export declare const continuousFlowKickoffRule: CeremonyTriggerRule;
//# sourceMappingURL=continuous-flow-kickoff.d.ts.map