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
export const EXPENSIVE_QUERY_WINDOW_DAYS = 30

/** Milliseconds in one day — convenience constant. */
const MS_PER_DAY = 86_400_000

/**
 * The minimal filter shape that the heuristic inspects.
 * Both `AuditQueryFilter` (from audit/types.ts) and `EventQueryFilter`
 * (from events/types.ts) satisfy this shape; the function is therefore
 * usable from either surface without a hard import dependency.
 */
export interface QueryFilterForHeuristic {
  aggregate_id?: string | undefined
  event_type?: string | undefined
  event_types?: string[] | undefined
  occurred_from?: string | undefined
  occurred_to?: string | undefined
  /** Alternate field name used by EventQueryFilter. */
  occurred_after?: string | undefined
  /** Alternate field name used by EventQueryFilter. */
  occurred_before?: string | undefined
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
export function isExpensiveQuery(filter: QueryFilterForHeuristic): boolean {
  // Step 1: selective index filter presence check.
  const hasAggregateId = filter.aggregate_id !== undefined
  const hasEventType =
    filter.event_type !== undefined ||
    (Array.isArray(filter.event_types) && filter.event_types.length > 0)

  // If either selective filter is present, the planner will use a narrow index.
  if (hasAggregateId || hasEventType) return false

  // Step 2: window width check.
  // Support both naming conventions (occurred_from/to and occurred_after/before).
  const fromStr = filter.occurred_from ?? filter.occurred_after
  const toStr = filter.occurred_to ?? filter.occurred_before

  if (fromStr !== null && fromStr !== undefined && toStr !== null && toStr !== undefined) {
    const fromMs = new Date(fromStr).getTime()
    const toMs = new Date(toStr).getTime()
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      // Unparseable timestamps — treat as wide (conservative).
      return true
    }
    const rangeMs = toMs - fromMs
    return rangeMs > EXPENSIVE_QUERY_WINDOW_DAYS * MS_PER_DAY
  }

  // No time range bounds at all ⇒ effectively unbounded ⇒ expensive.
  return true
}

/**
 * Describe *why* a query is expensive (for logging and payload annotation).
 * Returns a human-readable string suitable for the `AuditQueryExecuted` payload
 * or a structured log entry.
 *
 * Returns null when the query is not expensive (isExpensiveQuery returns false).
 */
export function expensiveQueryReason(filter: QueryFilterForHeuristic): string | null {
  if (!isExpensiveQuery(filter)) return null

  const reasons: string[] = []

  if (!filter.aggregate_id) reasons.push('no aggregate_id filter')
  if (
    !filter.event_type &&
    (!Array.isArray(filter.event_types) || filter.event_types.length === 0)
  ) {
    reasons.push('no event_type filter')
  }

  const fromStr = filter.occurred_from ?? filter.occurred_after
  const toStr = filter.occurred_to ?? filter.occurred_before

  if (fromStr === undefined && toStr === undefined) {
    reasons.push('no time range bounds (unbounded scan)')
  } else if (fromStr !== undefined && toStr !== undefined) {
    const fromMs = new Date(fromStr).getTime()
    const toMs = new Date(toStr).getTime()
    const days = Math.round((toMs - fromMs) / MS_PER_DAY)
    reasons.push(`time window ${days} days > ${EXPENSIVE_QUERY_WINDOW_DAYS} day threshold`)
  }

  return reasons.join('; ')
}
