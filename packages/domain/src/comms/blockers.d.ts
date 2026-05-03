/**
 * blockers.ts — BlockerService.
 *
 * Per TRD-05 §4.3, §6.2.6 (`blocker.raise`), §7.5 (state machine), §10.7
 * (routing).
 *
 * Lifecycle: raised → routed → in_resolution → resolved
 *                ↓ (retries exhausted or critical)
 *            escalated
 *
 * `raise()` writes the structured row + a `post_type='blocker'` post in the
 * originating ticket channel + emits `BlockerRaised`.
 *
 * `routeToResolver()` reads the persona resolver policy, computes the next
 * candidate, emits `BlockerRouted`, and (best-effort) calls `Scheduler.addTask`
 * to spawn a resolver worker. Phase 4B will refine the spawn handoff; for
 * Phase 3A we emit `TaskCreated` for the resolver task so the existing
 * scheduler picks it up on its next tick.
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { CapabilityBundle, Actor } from '@orbital/types';
import { type BlockerUrgency } from '@orbital/db';
import type { ChannelsService } from './channels.js';
/**
 * Default routing chain per role. Customizable via constructor options.
 * If a role's chain is exhausted, escalation kicks in.
 */
export declare const DEFAULT_RESOLVER_CHAIN: Record<string, string[]>;
export interface RaiseBlockerParams {
    raisingActor: Actor;
    raisingTaskId: string;
    ticketId?: string;
    question: string;
    context: string;
    requestedResolverRole: string;
    urgency: BlockerUrgency;
    capability?: CapabilityBundle;
    justification: string;
}
export interface RaiseBlockerResult {
    blockerId: string;
    originPostId: string;
    raisedEventId: string;
}
export interface RouteResult {
    blockerId: string;
    routedToRole: string;
    routedToTaskId: string;
    routingAttempt: number;
    routedEventId: string;
}
export interface BlockerService {
    raise(params: RaiseBlockerParams): Promise<RaiseBlockerResult>;
    /**
     * Compute next-in-chain resolver and route. Updates blocker row state
     * (raised → routed → in_resolution) and emits BlockerRouted. If the chain
     * is exhausted, this method calls escalate() instead and returns null.
     */
    routeToResolver(blockerId: string): Promise<RouteResult | null>;
    resolve(params: {
        blockerId: string;
        resolutionPostId: string;
        resolvedByRole: string;
        actor: Actor;
    }): Promise<void>;
    escalate(params: {
        blockerId: string;
        reason: 'routing_exhausted' | 'critical_class' | 'tie_breaker_failed';
        attachedAnalysis?: string;
        actor?: Actor;
    }): Promise<void>;
    /**
     * Set or replace the routing callback at runtime. Phase 4B's SprintService
     * uses this to wire Scheduler-aware task spawning at sprint start.
     */
    setOnRoute(callback: BlockerServiceOptions['onRoute'] | undefined): void;
}
export interface BlockerServiceOptions {
    /** Override the resolver chain map. */
    resolverChain?: Record<string, string[]>;
    /**
     * Optional callback fired when a routing decision selects a resolver.
     * Phase 4B's SprintService wires this to Scheduler.addTask. For 3A the
     * default emits a TaskCreated event so existing schedulers pick it up.
     */
    onRoute?: (decision: {
        blockerId: string;
        resolverRole: string;
        resolverTaskId: string;
        raisingTaskId: string;
        ticketId: string | null;
    }) => Promise<void> | void;
}
export declare class DefaultBlockerService implements BlockerService {
    private readonly db;
    private readonly eventStore;
    private readonly channels;
    private readonly resolverChain;
    private onRoute?;
    constructor(db: DB, eventStore: EventStore, channels: ChannelsService, options?: BlockerServiceOptions);
    /**
     * Replace (or set) the onRoute callback at runtime.
     *
     * Phase 4B's SprintService binds Scheduler-aware task spawning at sprint
     * start. Existing constructor-supplied callbacks are overwritten; pass
     * `undefined` to detach.
     */
    setOnRoute(callback: BlockerServiceOptions['onRoute'] | undefined): void;
    raise(params: RaiseBlockerParams): Promise<RaiseBlockerResult>;
    routeToResolver(blockerId: string): Promise<RouteResult | null>;
    resolve(params: {
        blockerId: string;
        resolutionPostId: string;
        resolvedByRole: string;
        actor: Actor;
    }): Promise<void>;
    escalate(params: {
        blockerId: string;
        reason: 'routing_exhausted' | 'critical_class' | 'tie_breaker_failed';
        attachedAnalysis?: string;
        actor?: Actor;
    }): Promise<void>;
}
export declare function blockerDurableChannelName(ticketId: string): string;
//# sourceMappingURL=blockers.d.ts.map