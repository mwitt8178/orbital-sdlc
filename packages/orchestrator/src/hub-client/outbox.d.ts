/**
 * hub-client/outbox.ts — Persistent local outbox for hub fan-out.
 *
 * Round 7-02 — In-memory outbox (original implementation)
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-06 — Persistent outbox (extended for offline + reconciliation)
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * When a MCP tool call emits an event, the audit middleware writes to:
 *   1. Local EventStore (always — for replay/inspection).
 *   2. Hub via this outbox (when hub configured — for cross-operator visibility).
 *
 * Round 7-06 extensions:
 *   - PersistentHubOutbox: uses the local_outbox Postgres table so entries
 *     survive process restarts. Flush runs in seq order to preserve event
 *     ordering at the hub.
 *   - Idempotency: every row carries a client-generated idempotency_key (UUID).
 *     The hub deduplicates within a 24h window. Same key sent twice → single
 *     hub row; the second call returns the first result.
 *   - Connection-state awareness: the outbox worker checks the WS connection
 *     state before attempting a flush. When offline, no flush is attempted;
 *     rows accumulate until the next connected flush cycle.
 *   - Failure handling: permanent failures (4xx hub responses) are marked with
 *     last_error and will NOT be retried automatically. The UI's
 *     PendingMutationsPanel surfaces them for operator resolution.
 *
 * In-memory outbox (v1) is retained as MemoryHubOutbox for callers that do not
 * have a DB connection (e.g., unit tests, boot-time before DB is available).
 * PersistentHubOutbox is the default when a DB is provided.
 *
 * Drain behaviour:
 *   - Drains sequentially (in seq order) to preserve event ordering on the hub.
 *   - On hub 5xx failure: increment attempts, exponential backoff.
 *   - On hub 4xx (permanent failure): mark last_error; stop retrying (surfaced
 *     to operator in UI).
 *   - After all pending flushed: the outbox signals the ws-client to request
 *     event backfill since last_seen_event_id.
 */
import type { HubClient } from './client.js';
import type { HubEventInput } from './types.js';
import type { DB } from '../db/client.js';
/** A hub-bound mutation to enqueue (non-event RPC call). */
export interface OutboxMutation {
    endpoint: string;
    payload: Record<string, unknown>;
    idempotency_key?: string;
}
/** A hub-bound event to enqueue. */
export interface OutboxEvent {
    event: HubEventInput;
    idempotency_key?: string;
}
export interface HubOutboxOptions {
    /** Max retry attempts before marking row as permanently failed. Default 5. */
    maxRetries?: number;
    /** Base backoff ms between retries. Default 500. */
    baseBackoffMs?: number;
    /** Drain interval ms when connected. Default 200. */
    drainIntervalMs?: number;
    /** Whether to auto-start the drain loop on construction. Default false. */
    autoStart?: boolean;
}
/** Status of a single outbox entry as seen by the UI. */
export type OutboxEntryStatus = 'pending' | 'retrying' | 'failed';
export interface OutboxEntryView {
    seq: bigint;
    kind: 'event' | 'mutation';
    endpoint: string;
    idempotency_key: string;
    created_at: string;
    attempts: number;
    last_error: string | null;
    status: OutboxEntryStatus;
}
export interface HubOutbox {
    /** Enqueue an event for fan-out to the hub. Returns immediately. */
    enqueue(event: HubEventInput): Promise<void>;
    /** Enqueue a mutation. Returns immediately. */
    enqueueMutation(mutation: OutboxMutation): Promise<void>;
    /** Start the drain loop. */
    start(): void;
    /** Stop the drain loop; waits for the current drain to finish. */
    stop(): Promise<void>;
    /** Test accessor — count of pending (unflushed) rows. */
    queueDepth(): Promise<number>;
    /** Get pending entries for UI display (pending + failed). */
    getPendingEntries(): Promise<OutboxEntryView[]>;
    /** Mark a permanently-failed row as dismissed (operator chose to discard). */
    dismiss(seq: bigint): Promise<void>;
}
/** Thin abstraction so the outbox can ask "is hub reachable right now?". */
export type ConnectionStateSource = () => 'connected' | 'reconnecting' | 'offline';
/**
 * createPersistentHubOutbox — construct the persistent (DB-backed) outbox.
 * Preferred in production. Uses local_outbox table.
 *
 * @param db                 Drizzle DB instance (local Postgres)
 * @param hubClient          Hub HTTP client
 * @param getConnectionState Function returning current WS connection state
 * @param opts               Tuning options
 */
export declare function createPersistentHubOutbox(db: DB, hubClient: HubClient, getConnectionState: ConnectionStateSource, opts?: HubOutboxOptions): HubOutbox;
/**
 * createHubOutbox — construct an in-memory outbox (v1 / fallback).
 * Retained for callers that do not have a DB connection.
 */
export declare function createHubOutbox(hubClient: HubClient, opts?: HubOutboxOptions): HubOutbox;
//# sourceMappingURL=outbox.d.ts.map