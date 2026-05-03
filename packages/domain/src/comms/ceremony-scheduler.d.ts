/**
 * ceremony-scheduler.ts — Agent-native CeremonyScheduler.
 *
 * Per TRD-05 §6.2.6 (ceremony lifecycle).
 *
 * Responsibilities:
 *   - subscribe to EventStore via .subscribe(null, handler)
 *   - hold a registry of CeremonyTriggerRule instances
 *   - for each event:
 *       1. Check each rule whose `triggers` include the event_type
 *       2. Run rule.match(envelope, ctx) -> CeremonySpec | null
 *       3. If match AND no dedupe collision -> CeremonyService.schedule(spec)
 *       4. Emit CeremonyAutoScheduled with rule_id + trigger_event_id
 *
 * Dedupe: a single composite-PK row in `ceremony_trigger_firings` per
 * (rule_id, trigger_event_id). INSERT...ON CONFLICT DO NOTHING claims the
 * firing slot atomically; subsequent attempts (subscriber redelivery,
 * multi-process boot) are silent no-ops.
 *
 * Ceremonies fire on system state + events, never on a clock.
 */
import { type EventEnvelope } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { CeremonyService, ScheduleCeremonyParams } from './ceremonies.js';
/**
 * Spec returned by a CeremonyTriggerRule.match — the inputs a rule provides to
 * `CeremonyService.schedule`, plus optional invitation hints recorded in the
 * scope for the UI / future participant-spawn step.
 */
export type CeremonySpec = ScheduleCeremonyParams & {
    /**
     * Persona roles to invite. Recorded as part of `scope.invited_roles` so the
     * UI sibling agent can render the invitation list. Participant rows are NOT
     * created here — that happens during ceremony.start when the chair
     * persona invites the actors. Keeping this advisory keeps the scheduler
     * stateless w.r.t. participant identity.
     */
    invitedRoles?: string[];
};
/**
 * Context passed to every rule.match call.
 *
 * - `db` for state-of-the-world SQL queries (cheaper than event-log scans for
 *   "current backlog count" style checks).
 * - `eventStore` for cross-event correlation (rare; most rules use db).
 * - `ceremonyService` is included for completeness; rules return a spec rather
 *   than calling `schedule` directly so dedupe/idempotency stays centralized.
 * - `alreadyFired(ruleId, triggerEventId)` is provided as an explicit hook for
 *   rules that want to short-circuit before doing expensive state queries; the
 *   scheduler always re-checks via the dedupe insert before scheduling.
 */
export interface TriggerContext {
    db: DB;
    eventStore: EventStore;
    ceremonyService: CeremonyService;
    alreadyFired(ruleId: string, triggerEventId: string): Promise<boolean>;
}
/**
 * A trigger rule: cheap pre-filter via `triggers`, then a state-aware
 * `match()` that returns a CeremonySpec or null.
 *
 * Implementations live in `comms/ceremony-triggers/*.ts`, one per rule.
 */
export interface CeremonyTriggerRule {
    id: string;
    description: string;
    triggers: string[];
    match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null>;
}
export interface CeremonySchedulerOptions {
    /** Skip wiring (returns a no-op start/stop). */
    disabled?: boolean;
    /**
     * Hook invoked after a successful auto-schedule. Tests use this to await the
     * effect of a synthetic event without polling.
     */
    onCeremonyAutoScheduled?: (info: {
        ceremonyId: string;
        ruleId: string;
        triggerEventId: string;
        ceremonyType: string;
    }) => void;
}
export interface CeremonySchedulerDeps {
    db: DB;
    eventStore: EventStore;
    ceremonyService: CeremonyService;
    ruleRegistry: CeremonyTriggerRule[];
    options?: CeremonySchedulerOptions;
}
export interface CeremonyScheduler {
    start(): void;
    stop(): void;
    /** Direct entry point — bypass subscribe; tests drive events through here. */
    onEvent(envelope: EventEnvelope): Promise<void>;
    /** List of registered rule ids; useful for diagnostics + tests. */
    registeredRuleIds(): string[];
}
export declare class DefaultCeremonyScheduler implements CeremonyScheduler {
    private readonly db;
    private readonly eventStore;
    private readonly ceremonyService;
    private readonly rules;
    private readonly options;
    private unsubscribe;
    /** Map from event_type -> matching rules; built once at construction. */
    private readonly rulesByEventType;
    constructor(deps: CeremonySchedulerDeps);
    start(): void;
    stop(): void;
    registeredRuleIds(): string[];
    onEvent(envelope: EventEnvelope): Promise<void>;
    private fireRule;
    private alreadyFired;
}
export declare function createCeremonyScheduler(deps: CeremonySchedulerDeps): CeremonyScheduler;
//# sourceMappingURL=ceremony-scheduler.d.ts.map