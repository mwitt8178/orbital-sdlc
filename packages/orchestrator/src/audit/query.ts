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

import { uuidv7 } from 'uuidv7'
import { eq, and, lt, gte, or, type SQL } from 'drizzle-orm'
import { sql as dSQL } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { events } from '../db/schema/events.js'
import { logger } from '../config/logger.js'
import type { EventStore } from '../events/store.js'
import { encodeCursor, decodeCursor } from '../events/types.js'
import type { EventEnvelope, PaginatedResponse, Actor } from '@orbital/types'
import type { AuditQueryFilter, AuditQueryExecutedPayload } from './types.js'
import { isExpensiveQuery, expensiveQueryReason } from './expensive-query.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Default actor used when the caller does not supply one. */
const DEFAULT_ACTOR: Actor = { type: 'system', component: 'audit_service' }

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
  query(filter: AuditQueryFilter, actor?: Actor): Promise<PaginatedResponse<EventEnvelope>>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PostgresAuditQueryService implements AuditQueryService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async query(filter: AuditQueryFilter, actor: Actor = DEFAULT_ACTOR): Promise<PaginatedResponse<EventEnvelope>> {
    const startMs = Date.now()

    const limit = filter.limit ?? 100
    const cursor = decodeCursor(filter.after)

    const conditions: SQL[] = []

    // aggregate_type
    if (filter.aggregate_type !== undefined) {
      conditions.push(eq(events.aggregateType, filter.aggregate_type))
    }

    // aggregate_id
    if (filter.aggregate_id !== undefined) {
      conditions.push(eq(events.aggregateId, filter.aggregate_id))
    }

    // event_types (OR semantics) — per TRD-07 §6.1.1
    const eventTypesFilter = buildEventTypesFilter(filter)
    if (eventTypesFilter !== null) {
      conditions.push(eventTypesFilter)
    }

    // actor_type and actor_id — JSONB extraction
    const actorCondition = buildActorCondition(filter)
    if (actorCondition !== null) {
      conditions.push(actorCondition)
    }

    // occurred_at range
    if (filter.occurred_from !== undefined) {
      conditions.push(gte(events.occurredAt, filter.occurred_from))
    }
    if (filter.occurred_to !== undefined) {
      conditions.push(lt(events.occurredAt, filter.occurred_to))
    }

    // trace_id
    if (filter.trace_id !== undefined) {
      conditions.push(eq(events.traceId, filter.trace_id))
    }

    // Cursor pagination (occurred_at DESC, event_id DESC)
    // Per TRD-07 §6.1.1 cursor semantics
    if (cursor !== null) {
      conditions.push(
        or(
          lt(events.occurredAt, cursor.occurred_at),
          and(
            eq(events.occurredAt, cursor.occurred_at),
            lt(events.eventId, cursor.event_id),
          ),
        ) as SQL,
      )
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const rows = await this.db
      .select()
      .from(events)
      .where(whereClause)
      .orderBy(dSQL`${events.occurredAt} DESC`, dSQL`${events.eventId} DESC`)
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const items = pageRows.map((row) => rowToEnvelope(row))

    const lastItem = items[items.length - 1]
    const nextCursor =
      hasMore && lastItem !== undefined
        ? encodeCursor(lastItem.occurred_at, lastItem.event_id)
        : null

    const result: PaginatedResponse<EventEnvelope> = {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
    }

    const durationMs = Date.now() - startMs

    // Emit AuditQueryExecuted for expensive queries.
    // Per TRD-07 §13: heuristic in expensive-query.ts.
    if (isExpensiveQuery(filter)) {
      const reason = expensiveQueryReason(filter)
      if (reason !== null) {
        logger.info(
          { filter: sanitizeFilters(filter), reason, rows_returned: items.length, duration_ms: durationMs },
          'AuditQueryService: expensive query detected — emitting AuditQueryExecuted',
        )
      }
      await this.emitAuditQueryExecuted(filter, items.length, durationMs, actor)
    }

    return result
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async emitAuditQueryExecuted(
    filter: AuditQueryFilter,
    rowsReturned: number,
    durationMs: number,
    actor: Actor,
  ): Promise<void> {
    try {
      const payload: AuditQueryExecutedPayload = {
        query_shape: 'audit.events.query',
        filters: sanitizeFilters(filter),
        rows_returned: rowsReturned,
        duration_ms: durationMs,
      }

      await this.eventStore.append({
        aggregate_id: uuidv7(),
        aggregate_type: 'system',
        event_type: 'AuditQueryExecuted',
        payload: payload as Record<string, unknown>,
        actor,
        trace_id: `audit-query-${uuidv7()}`,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      })
    } catch (err) {
      // Non-fatal: audit query logging failure must not fail the query itself.
      logger.warn({ err }, 'AuditQueryService: failed to emit AuditQueryExecuted event')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the event_types condition (OR semantics when multiple types given).
 */
function buildEventTypesFilter(filter: AuditQueryFilter): SQL | null {
  const types: string[] = []

  if (filter.event_type !== undefined) types.push(filter.event_type)
  if (filter.event_types !== undefined) types.push(...filter.event_types)

  if (types.length === 0) return null
  if (types.length === 1) {
    return eq(events.eventType, types[0]!)
  }

  // Multiple types: OR
  const clauses = types.map((t) => eq(events.eventType, t))
  return or(...clauses) as SQL
}

/**
 * Build actor conditions from actor_type and/or actor_id filters.
 * The actor column is JSONB; we extract fields via ->> operator.
 */
function buildActorCondition(filter: AuditQueryFilter): SQL | null {
  const { actor_type, actor_id } = filter

  if (actor_id !== undefined) {
    if (actor_type === 'persona') {
      return dSQL`${events.actor}->>'persona_id' = ${actor_id}` as SQL
    } else if (actor_type === 'user') {
      return dSQL`${events.actor}->>'user_id' = ${actor_id}` as SQL
    } else if (actor_type === 'hook') {
      return dSQL`${events.actor}->>'hook_id' = ${actor_id}` as SQL
    } else {
      // No actor_type: OR across all id fields
      return or(
        dSQL`${events.actor}->>'persona_id' = ${actor_id}`,
        dSQL`${events.actor}->>'user_id' = ${actor_id}`,
        dSQL`${events.actor}->>'hook_id' = ${actor_id}`,
      ) as SQL
    }
  }

  if (actor_type !== undefined) {
    return dSQL`${events.actor}->>'type' = ${actor_type}` as SQL
  }

  return null
}

/**
 * Sanitize filters for the AuditQueryExecuted payload.
 * Remove any deeply nested values that could contain PII; keep structure.
 */
function sanitizeFilters(filter: AuditQueryFilter): Record<string, unknown> {
  const { after: _after, limit: _limit, ...rest } = filter
  return rest as Record<string, unknown>
}

/**
 * Map a Drizzle events row to an EventEnvelope.
 * Mirrors the implementation in events/types.ts but kept local to avoid
 * circular imports between events/ and audit/.
 */
function rowToEnvelope(row: {
  eventId: string
  aggregateId: string
  aggregateType: string
  eventType: string
  payload: unknown
  actor: unknown
  capabilityId: string | null
  parentEventId: string | null
  traceId: string
  occurredAt: string
  ingestedAt: string
  schemaVersion: number
}): EventEnvelope {
  return {
    event_id: row.eventId,
    aggregate_id: row.aggregateId,
    aggregate_type: row.aggregateType as EventEnvelope['aggregate_type'],
    event_type: row.eventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    actor: row.actor as EventEnvelope['actor'],
    capability_id: row.capabilityId ?? undefined,
    parent_event_id: row.parentEventId ?? undefined,
    trace_id: row.traceId,
    occurred_at: toIso8601(row.occurredAt),
    ingested_at: toIso8601(row.ingestedAt),
    schema_version: row.schemaVersion,
  }
}

function toIso8601(ts: string): string {
  return ts.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuditQueryService(db: DB, eventStore: EventStore): AuditQueryService {
  return new PostgresAuditQueryService(db, eventStore)
}
