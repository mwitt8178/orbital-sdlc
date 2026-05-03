/**
 * Postgres LISTEN/NOTIFY client for the events_channel.
 *
 * Per TRD-07 §4.1.4 and §8.4:
 * - NOTIFY is best-effort; subscribers MUST implement cursor-resync on (re)connect.
 * - On connect: backfill any events newer than the given cursor via SELECT.
 * - After backfill: switch to LISTEN for low-latency delivery.
 * - Periodically (every 60s): re-issue cursor query as defensive backfill.
 *
 * Uses postgres.js sql.listen() which creates a dedicated connection for the
 * LISTEN subscription (separate from the main pool).
 *
 * NOTE: This module does NOT import from ../db/client — it accepts the sql
 * instance as a parameter so tests can pass isolated connections.
 */
import type postgres from 'postgres';
import type { EventEnvelope } from './types.js';
export type EventHandler = (event: EventEnvelope) => void | Promise<void>;
/** Handle returned by registerHandler; call it to remove the handler. */
export type Unsubscribe = () => void;
/**
 * Manages all LISTEN subscriptions on a single shared dedicated connection.
 * Multiple consumers call registerHandler; each gets its own Unsubscribe.
 */
export declare class NotifyClient {
    private readonly sql;
    /**
     * Callback for backfill: when a NOTIFY arrives (or on reconnect / periodic
     * poll), the NotifyClient calls this with the event_id to fetch the full
     * event row. Provided by EventStore to break circular dependency.
     */
    private readonly fetchById;
    /**
     * Callback for cursor backfill: on (re)connect, fetches all events after
     * the given event_id in event_id ordering so subscribers don't miss events
     * that arrived while disconnected.
     */
    private readonly backfillSince;
    private readonly handlers;
    private unlistenFn;
    private periodicTimer;
    private connected;
    constructor(sql: postgres.Sql, 
    /**
     * Callback for backfill: when a NOTIFY arrives (or on reconnect / periodic
     * poll), the NotifyClient calls this with the event_id to fetch the full
     * event row. Provided by EventStore to break circular dependency.
     */
    fetchById: (eventId: string) => Promise<EventEnvelope | null>, 
    /**
     * Callback for cursor backfill: on (re)connect, fetches all events after
     * the given event_id in event_id ordering so subscribers don't miss events
     * that arrived while disconnected.
     */
    backfillSince: (afterEventId: string | null) => Promise<EventEnvelope[]>);
    /**
     * Start listening. Safe to call multiple times (idempotent).
     * Performs a backfill from `cursor` before switching to LISTEN mode.
     */
    start(cursor: string | null): Promise<void>;
    /** Stop listening and release the connection. Returns a promise that resolves when unlisten completes. */
    stop(): Promise<void>;
    /** Register a handler. Returns an unsubscribe function. */
    registerHandler(handler: EventHandler): Unsubscribe;
    private onNotify;
    private dispatch;
}
//# sourceMappingURL=notify.d.ts.map