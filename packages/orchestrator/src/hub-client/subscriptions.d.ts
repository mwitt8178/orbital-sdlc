/**
 * hub-client/subscriptions.ts — WebSocket subscription client for hub events.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * The local UI subscribes to hub WS for shared events (tasks.*, channels.*,
 * memory.*, etc.) and to the local WS for local-only events (workers,
 * inspection, cost).
 *
 * This module manages the connection from the local orchestrator process to the
 * hub WS server. The hub broadcasts events to subscribers; this client receives
 * them and re-emits on the local EventStore so the local WebSocketHub fans them
 * out to connected UI clients.
 *
 * Connection lifecycle:
 *   - start(): open WS, subscribe to configured channels
 *   - stop(): close WS
 *   - auto-reconnect with exponential backoff (max 30s)
 *
 * Requires the `ws` package (already a dependency of the orchestrator).
 */
import type { EventEnvelope } from '@orbital/types';
export type HubEventHandler = (event: EventEnvelope) => void;
export interface HubSubscriptionOptions {
    /** Hub WS URL, e.g. wss://orbital.team.dev/ws */
    hubWsUrl: string;
    /** Tenant ID included in subscribe messages. */
    tenantId: string;
    /** Channel ids to subscribe. Default: ['tasks', 'memory', 'channels', 'audit']. */
    channelIds?: string[];
    /** Called for each event received from the hub. */
    onEvent: HubEventHandler;
    /** Called when connection state changes. */
    onStatusChange?: (connected: boolean) => void;
    /** Initial reconnect delay ms. Default 1000. */
    initialReconnectMs?: number;
    /** Max reconnect delay ms. Default 30_000. */
    maxReconnectMs?: number;
}
export interface HubSubscriptionClient {
    start(): void;
    stop(): void;
    isConnected(): boolean;
}
/**
 * createHubSubscriptionClient — construct a WS subscription client.
 *
 * Returns null if hubWsUrl is not provided (no-hub mode).
 */
export declare function createHubSubscriptionClient(opts: HubSubscriptionOptions): HubSubscriptionClient;
//# sourceMappingURL=subscriptions.d.ts.map