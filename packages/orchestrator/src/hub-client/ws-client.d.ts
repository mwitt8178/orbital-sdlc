/**
 * hub-client/ws-client.ts — Local-side WS client for hub real-time push.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Round 7-06 — Hardened reconnect backfill + offline state mapping
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * When the local Orbital instance is configured with a hub (ORBITAL_HUB_URL),
 * this client connects to the hub's WS endpoint using a signed envelope for
 * auth (same key as hub-client/auth.ts).
 *
 * Responsibilities:
 *   - Connect to hub WS over WSS/WS with envelope auth in query params.
 *   - Reconnect with exponential backoff: 1s → 2s → 4s → max 30s.
 *   - On reconnect: re-authenticate (fresh envelope signed at connect time),
 *     re-subscribe to all previous patterns, request events since
 *     last_seen_event_id via cursor in the subscribe message.
 *   - Emit events to registered handlers (one handler per subscription pattern).
 *   - Track the last_seen_event_id for backfill on reconnect.
 *   - Report connection status changes (connected/reconnecting/disconnected).
 *
 * Round 7-06 additions:
 *   - getConnectionStateForOutbox(): maps WsClientStatus → HubConnectionState
 *     so the persistent outbox can use the WS client as its connection source.
 *   - onReconnected callback: called after resubscription so the outbox can
 *     start its flush cycle after the WS is ready (events-since backfill
 *     request is already handled by the cursor in the subscribe message).
 *   - Hardened backfill: the cursor sent in the subscribe message on reconnect
 *     guarantees the hub replays any events missed during the disconnect window.
 *     The hub's subscribe handler looks up events > cursor and pushes them
 *     before resuming live push. This is the "events since last_seen_event_id"
 *     flow documented in architecture.md.
 *
 * Auth: a fresh signed envelope is created at each connect attempt. The
 * method signed is 'ws.connect'; body is empty. The params go on the WS URL
 * as query string (install_id, sig, sig_body).
 *
 * Design notes:
 *   - Uses Node.js native WebSocket (v22+) or falls back to the `ws` package.
 *   - Runs as a process singleton via hub-client/index.ts.
 *   - No mocks; callers in tests use a real hub or skip hub-client tests.
 */
import type { EventEnvelope } from '@orbital/types';
import type { HubConnectionState } from './client.js';
export type WsClientStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type HubWsEventHandler = (event: EventEnvelope) => void;
export interface HubWsSubscription {
    pattern: string;
    handler: HubWsEventHandler;
}
export interface HubWsClientOptions {
    /** Hub WS base URL, e.g. wss://orbital.team.dev or ws://localhost:3001 */
    hubWsUrl: string;
    /** Initial reconnect delay in ms. Default 1000. */
    initialReconnectMs?: number;
    /** Maximum reconnect delay in ms. Default 30_000. */
    maxReconnectMs?: number;
    /** Called on status transitions. */
    onStatusChange?: (status: WsClientStatus) => void;
    /**
     * Round 7-06: called after a successful reconnect + resubscription.
     * The outbox hooks this to trigger a flush cycle immediately after the WS
     * is ready, rather than waiting for the next drain interval tick.
     */
    onReconnected?: () => void;
}
export interface HubWsClient {
    start(): void;
    stop(): void;
    /** Subscribe to a pattern. Handler called for every matching event. */
    subscribe(pattern: string, handler: HubWsEventHandler): () => void;
    /** Unsubscribe a pattern (removes all handlers for it). */
    unsubscribe(pattern: string): void;
    isConnected(): boolean;
    status(): WsClientStatus;
    /** Last event_id received — used as cursor on reconnect. */
    lastSeenEventId(): string | null;
    /**
     * Round 7-06: map WS status to HubConnectionState for the outbox.
     * 'connected' → 'connected'
     * 'reconnecting' | 'connecting' → 'reconnecting'
     * 'disconnected' → 'offline'
     */
    connectionStateForOutbox(): HubConnectionState;
}
export declare function createHubWsClient(opts: HubWsClientOptions): HubWsClient;
/**
 * Create from env (ORBITAL_HUB_URL → derive ws URL).
 * Returns null if ORBITAL_HUB_URL not set.
 */
export declare function createHubWsClientFromEnv(onStatusChange?: (status: WsClientStatus) => void): HubWsClient | null;
//# sourceMappingURL=ws-client.d.ts.map