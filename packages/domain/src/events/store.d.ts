/**
 * EventStore — the append-only event log service.
 *
 * Per Task 1A spec and TRD-07 §6:
 * - append(): writes a real row, generates UUIDv7 for event_id, returns full envelope.
 * - query(): paginated, filterable query with cursor pagination.
 * - subscribe(): LISTEN-based real-time delivery with cursor backfill on connect.
 *
 * Every write goes through this service. No direct db.insert(events) elsewhere.
 *
 * Per TRD-07 §8.1 (idempotency): if a duplicate event_id is inserted (Postgres
 * error 23505), the store treats it as success-by-prior-write and returns the
 * existing envelope.
 *
 * Round 7-06 — Local-mode write when hub is down
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * append() always succeeds for the local write. The hub-bound mirror is handled
 * by the caller's fanout layer (7-02/7-04). When the hub is unreachable, the
 * caller queues to the persistent outbox instead. The EventStore itself is
 * hub-unaware — it writes to local Postgres unconditionally.
 *
 * This is already the behaviour from 7-02 and 7-04. The 7-06 addition is the
 * appendWithOutboxFallback() helper that the MCP audit middleware calls: it
 * attempts the hub fanout; if the hub client is offline or the call fails, it
 * enqueues to the persistent outbox rather than dropping the event.
 */
import type { DB } from '@orbital/db';
import type postgres from 'postgres';
import type { EventEnvelope, EventInput, EventQueryFilter, PaginatedResponse } from './types.js';
export interface EventStore {
    /**
     * Append a new event. Generates event_id (UUIDv7) and fills ingested_at.
     * Returns the fully-written envelope (including server-assigned ingested_at).
     */
    append(event: EventInput): Promise<EventEnvelope>;
    /**
     * Paginated, filterable query over the events log.
     * Per TRD-07 §6.1.1.
     */
    query(filter: EventQueryFilter): Promise<PaginatedResponse<EventEnvelope>>;
    /**
     * Register a LISTEN handler for new events.
     * Backfills any events newer than `cursor` on connect.
     * Returns an unsubscribe function.
     *
     * Per TRD-07 §4.1.4: subscribers MUST handle cursor-resync on (re)connect.
     */
    subscribe(cursor: string | null, handler: (event: EventEnvelope) => void): () => void;
}
export declare class PostgresEventStore implements EventStore {
    private readonly db;
    private readonly sql;
    private notifyClient;
    constructor(db: DB, sql: postgres.Sql);
    append(event: EventInput): Promise<EventEnvelope>;
    query(filter: EventQueryFilter): Promise<PaginatedResponse<EventEnvelope>>;
    subscribe(cursor: string | null, handler: (event: EventEnvelope) => void): () => void;
    /** Fetch a single event by id. Returns null if not found. */
    getById(eventId: string): Promise<EventEnvelope | null>;
    /**
     * Backfill events newer than afterEventId (ordered by event_id ASC).
     * Used by NotifyClient on (re)connect and periodic defensive poll.
     * Per TRD-07 §4.1.4.
     */
    private backfillSince;
    /** Expose stop for graceful shutdown. Awaitable. */
    stopNotifyClient(): Promise<void>;
}
/**
 * Create and return a configured EventStore using the shared db+sql connections.
 * Call once at startup; reuse the instance.
 */
export declare function createEventStore(db: DB, sql: postgres.Sql): EventStore;
import { LocalDataLeakError } from '../../../orchestrator/src/hub-client/sanitize.js';
/** Reset SNS client for tests. */
export declare function _resetSnsClientForTests(): void;
/**
 * appendAndPublish — append event to local DB, then publish to SNS if in AWS mode.
 *
 * Usage (AWS mode hub Lambda):
 *   import { appendAndPublish } from '../events/store.js'
 *   const envelope = await appendAndPublish(store, eventInput)
 *
 * The SNS publish error does NOT throw — the local write is authoritative.
 * SNS failures are logged as errors so alarms can detect persistent publish failures.
 */
export declare function appendAndPublish(store: PostgresEventStore, input: EventInput): Promise<EventEnvelope>;
/**
 * Sanitise an outbound event payload before fanout to the hub.
 *
 * Returns:
 *   - { ok: true } when the payload is safe to forward.
 *   - { ok: false, error } when local-only data was detected; caller MUST
 *     drop the hub fanout for this event but still keep the local write.
 *
 * The local Postgres write is NEVER blocked by the sanitiser — the sanitiser
 * only gates the LOCAL → HUB fanout. Local audit fidelity is sacrosanct.
 */
export declare function sanitizeEventForHubFanout(envelope: EventEnvelope): {
    ok: true;
} | {
    ok: false;
    error: LocalDataLeakError;
};
import type { HubClient } from '../../../orchestrator/src/hub-client/client.js';
import type { HubOutbox } from '../../../orchestrator/src/hub-client/outbox.js';
/**
 * appendWithOutboxFallback — write event locally and mirror to hub.
 *
 * Local write is unconditional. Hub fanout follows this policy:
 *   - hub null (local mode): no fanout — done.
 *   - hub 'offline': sanitise payload; if clean, enqueue to outbox.
 *   - hub 'connected'/'reconnecting': sanitise payload; attempt direct call.
 *     On failure: enqueue to outbox for retry.
 *
 * @param store      The local event store (writes to local Postgres).
 * @param input      The event to append.
 * @param hubClient  Hub HTTP client, or null when hub is not configured.
 * @param outbox     Persistent outbox, or null when hub is not configured.
 * @returns          The local EventEnvelope (hub result is fire-and-forget).
 */
export declare function appendWithOutboxFallback(store: PostgresEventStore, input: EventInput, hubClient: HubClient | null, outbox: HubOutbox | null): Promise<EventEnvelope>;
//# sourceMappingURL=store.d.ts.map