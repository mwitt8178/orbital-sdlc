/**
 * audit/expensive-query.ts — Heuristics for "expensive" audit queries.
 *
 * Per TRD-07 §13 and §6.1.1 ("Events emitted: AuditQueryExecuted if gated on"):
 *
 * A query is classified as "expensive" when it cannot benefit from the main
 * selective indexes, and therefore risks a full or near-full partition scan.
 * The v1 heuristic uses two measurable signals:
 *
 *   1. No `aggregate_id` AND no `event_type`/`event_types` filter set.
 *      (These are the two index-selective filters; without either, the planner
 *      must scan by `occurred_at` range alone.)
 *
 *   2. The `occurred_after`/`occurred_before` window exceeds 30 days.
 *      (A wide range over an unfiltered table can touch millions of rows.)
 *
 * When BOTH conditions hold, the query is marked expensive and
 * `AuditQueryExecuted` is emitted via EventStore.
 *
 * Deferred (v2):
 *   Row-count estimation from actual query results (>1000 rows). This can be
 *   folded in once the executor wraps the count from `EXPLAIN (ANALYZE)` or
 *   the actual result set size. Documented here so the v2 ticket has a clear
 *   starting point.
 *
 * The heuristic intentionally errs on the side of over-reporting: a false
 * positive (emitting for a query that is not actually slow) is cheap, whereas
 * a false negative (missing a genuinely expensive query) undermines the SOC2
 * CC7.1 monitoring signal.
 *
 * Exported pure functions so unit tests can exercise the heuristic without
 * instantiating a full service.
 */
/** Days threshold above which a time window is considered "wide". */
export declare const EXPENSIVE_QUERY_WINDOW_DAYS = 30;
/**
 * The minimal filter shape that the heuristic inspects.
 * Both `AuditQueryFilter` (from audit/types.ts) and `EventQueryFilter`
 * (from events/types.ts) satisfy this shape; the function is therefore
 * usable from either surface without a hard import dependency.
 */
export interface QueryFilterForHeuristic {
    aggregate_id?: string | undefined;
    event_type?: string | undefined;
    event_types?: string[] | undefined;
    occurred_from?: string | undefined;
    occurred_to?: string | undefined;
    /** Alternate field name used by EventQueryFilter. */
    occurred_after?: string | undefined;
    /** Alternate field name used by EventQueryFilter. */
    occurred_before?: string | undefined;
}
/**
 * Returns true when the query is classified as "expensive" by the v1
 * heuristic (see module-level doc-comment).
 *
 * A query is expensive when:
 *   - No aggregate_id filter (table cannot use `events_aggregate_occurred_at_idx`), AND
 *   - No event_type / event_types filter (cannot use `events_event_type_occurred_at_idx`), AND
 *   - The date window is wider than EXPENSIVE_QUERY_WINDOW_DAYS, or absent entirely.
 */
export declare function isExpensiveQuery(filter: QueryFilterForHeuristic): boolean;
/**
 * Describe *why* a query is expensive (for logging and payload annotation).
 * Returns a human-readable string suitable for the `AuditQueryExecuted` payload
 * or a structured log entry.
 *
 * Returns null when the query is not expensive (isExpensiveQuery returns false).
 */
export declare function expensiveQueryReason(filter: QueryFilterForHeuristic): string | null;
//# sourceMappingURL=expensive-query.d.ts.map