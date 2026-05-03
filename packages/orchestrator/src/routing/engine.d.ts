/**
 * RoutingEngine — selects the optimal LLM model for each task spawn.
 *
 * Per TRD-08 §6 (router function) and Implementation Plan §6 Task 2A.
 *
 * Key properties:
 * - The pure `decide()` function is < 1 ms: no I/O, no DB calls.
 * - Side effects (DB write, event emission) happen in `selectModel()`.
 * - RoutingDecisionMade is written via EventStore.append, never db.insert.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { RouterInput, RoutingDecision, RoutingPolicy, ModelCatalog, RouteModelInput, RouteModelResult } from './types.js';
/**
 * Pure router function — no I/O, no logging.
 * Per TRD-08 §6.1 and §6.2.
 */
export declare function decide(input: RouterInput, policy: RoutingPolicy, catalog: ModelCatalog, policyVersion: number): Omit<RoutingDecision, 'decision_id'>;
export interface RoutingEngine {
    selectModel(input: RouterInput): Promise<RoutingDecision>;
    /**
     * Multi-provider model routing.
     * Returns the provider + model to use for the given persona/estimate,
     * honouring the cross-family SoD rule when authorProvider/authorModel
     * are supplied.
     *
     * Per Round 6 #8 spec.
     */
    routeModel(input: RouteModelInput): Promise<RouteModelResult>;
}
export declare class DefaultRoutingEngine implements RoutingEngine {
    private readonly db;
    private readonly eventStore;
    private readonly policy;
    private readonly catalog;
    private readonly policyVersion;
    constructor(db: DB, eventStore: EventStore, policy: RoutingPolicy, catalog: ModelCatalog, policyVersion: number);
    selectModel(input: RouterInput): Promise<RoutingDecision>;
    routeModel(input: RouteModelInput): Promise<RouteModelResult>;
}
export declare function buildDefaultCatalog(): ModelCatalog;
export declare function createRoutingEngine(db: DB, eventStore: EventStore, policy: RoutingPolicy, catalog: ModelCatalog, policyVersion: number): RoutingEngine;
//# sourceMappingURL=engine.d.ts.map