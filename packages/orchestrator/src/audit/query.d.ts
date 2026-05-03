/**
 * audit/query.ts — AuditQueryService: filterable, paginated event log query.
 *
 * Per TRD-07 §6.1.1, §10.3:
 * - Supports all filter combinations (aggregate_type, aggregate_id, event_type,
 *   actor_type, actor_id, occurred_at range, trace_id)
 * - Cursor pagination (Primitives §12)
 * - Returns empty set (not error) for no-match queries
 * - Emits AuditQueryExecuted event for "expensive" queries (heuristic in
 *   audit/expensive-query.ts, exported separately for unit tests)
 *
 * Cost-gate heuristic (v1, per TRD-07 §13):
 *   See expensive-query.ts for the full rationale. Summary:
 *   - No aggregate_id AND no event_type filter → cannot use selective indexes.
 *   - Date window > 30 days → wide scan over un-narrowed partitions.
 *   Both conditions must hold for the query to be classified expensive.
 *
 * Actor parameter (backward-compatible optional):
 *   query(filter, actor?) — when omitted defaults to
 *   { type: 'system', component: 'audit_service' }. Callers that hold a real
 *   actor (tRPC handlers) should pass it so the AuditQueryExecuted event
 *   reflects the requesting identity.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { EventEnvelope, PaginatedResponse, Actor } from '@orbital/types';
import type { AuditQueryFilter } from './types.js';
export interface AuditQueryService {
    /**
     * Paginated, filterable query over the events log.
     * Per TRD-07 §6.1.1 — supports all documented filter combinations.
     * Returns empty items array (not an error) when no events match.
     *
     * @param filter  — query filters and pagination params.
     * @param actor   — optional requesting actor; used in the AuditQueryExecuted
     *                  event payload when the query is classified expensive. When
     *                  omitted, defaults to { type: 'system', component: 'audit_service' }.
     *                  Backward-compatible: callers that omit this param continue
     *                  to work unchanged.
     */
    query(filter: AuditQueryFilter, actor?: Actor): Promise<PaginatedResponse<EventEnvelope>>;
}
export declare class PostgresAuditQueryService implements AuditQueryService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    query(filter: AuditQueryFilter, actor?: Actor): Promise<PaginatedResponse<EventEnvelope>>;
    private emitAuditQueryExecuted;
}
export declare function createAuditQueryService(db: DB, eventStore: EventStore): AuditQueryService;
//# sourceMappingURL=query.d.ts.map