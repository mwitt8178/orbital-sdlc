/**
 * hub-client/client.ts — HTTP client that local routers proxy to when the hub
 * is configured (ORBITAL_HUB_URL set).
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-06 — Connection state machine + offline queuing
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Design:
 *   - Plain fetch() calls against the hub's tRPC HTTP endpoint.
 *   - Authorization: not yet wired (7-03 adds signed envelopes); for now
 *     we send the tenant ID via x-orbital-tenant-id header so hub
 *     tenant middleware resolves correctly.
 *   - Methods mirror the subset of tRPC procedures that hub-proxied routers
 *     need to call. Each method maps to a single tRPC batch request.
 *   - No singleton; callers construct via createHubClient(). Index.ts creates
 *     one instance at boot and shares it via DI.
 *
 * Round 7-06 additions:
 *   - Connection state machine: 'connected' | 'reconnecting' | 'offline'.
 *     - 'connected': hub reachable, calls proceed normally.
 *     - 'reconnecting': hub was reachable recently; calls attempted, failure
 *       transitions to 'offline'.
 *     - 'offline': hub unreachable; mutations enqueued to outbox instead of
 *       throwing. Queries return stale cached data or a graceful error.
 *   - setConnectionStateMachine(): wires up the ws-client status so the HTTP
 *     client tracks the same state the WS connection is in.
 *   - whenOffline(): allows callers to register an outbox enqueue callback
 *     that fires instead of the RPC when state is 'offline'.
 *
 * Backwards compat: if ORBITAL_HUB_URL is unset, createHubClient() returns
 * null and all callers fall through to local Postgres.
 */
import type { HubEventInput, HubEventEnvelope, HubTask, HubWorkerRegistration, HubProxyResult, HubStatus } from './types.js';
/**
 * HubConnectionState — tri-state connection machine.
 *
 * connected    Hub reachable; calls go through normally.
 * reconnecting Hub WS disconnected; HTTP calls still attempted but any failure
 *              transitions to 'offline'.
 * offline      Hub confirmed unreachable; mutations go to outbox, queries
 *              return graceful errors.
 */
export type HubConnectionState = 'connected' | 'reconnecting' | 'offline';
export interface HubClient {
    /** Current connection status — updated after each call. */
    readonly status: HubStatus;
    /**
     * Round 7-06: current connection state machine value.
     * Callers check this before sending mutations to decide whether to
     * enqueue to the outbox instead.
     */
    readonly connectionState: HubConnectionState;
    /**
     * Round 7-06: wire up an external state source (ws-client) so the HTTP
     * client tracks the same state as the WS connection. This allows the
     * outbox to use the same state source as the WS reconnect cycle.
     *
     * @param getState  Function returning the current WS client status mapped
     *                  to HubConnectionState.
     */
    setConnectionStateSource(getState: () => HubConnectionState): void;
    tasks: {
        list(tenantId: string, sprintId?: string): Promise<HubProxyResult<HubTask[]>>;
        get(tenantId: string, taskId: string): Promise<HubProxyResult<HubTask | null>>;
        claim(tenantId: string, taskId: string, installId: string): Promise<HubProxyResult<HubTask>>;
        updateState(tenantId: string, taskId: string, state: string): Promise<HubProxyResult<HubTask>>;
    };
    events: {
        append(event: HubEventInput): Promise<HubProxyResult<HubEventEnvelope>>;
    };
    workers: {
        register(reg: HubWorkerRegistration): Promise<HubProxyResult<HubWorkerRegistration>>;
        updateState(tenantId: string, workerId: string, state: string): Promise<HubProxyResult<HubWorkerRegistration>>;
    };
    /**
     * Generic RPC proxy — sends any tRPC procedure call to the hub.
     * Used by routers to forward queries/mutations without mapping each
     * procedure to a named client method.
     *
     * @param procedure  Full dot-path, e.g. 'memory.record', 'channel.list'
     * @param input      Procedure input (serialised as JSON)
     * @param tenantId   Tenant ID for x-orbital-tenant-id header
     */
    query<T>(procedure: string, input: unknown, tenantId: string): Promise<HubProxyResult<T>>;
    mutate<T>(procedure: string, input: unknown, tenantId: string): Promise<HubProxyResult<T>>;
    /** Ping the hub; returns true if reachable. */
    ping(): Promise<boolean>;
}
/**
 * createHubClient — construct a HubClient from env.
 *
 * Returns null if ORBITAL_HUB_URL is not set (local-only mode).
 * Callers check for null and fall through to local Postgres.
 */
export declare function createHubClient(): HubClient | null;
/**
 * createHubClientForTest — construct a client pointing at a specific URL.
 * Used by integration tests to point at a real second hub instance.
 */
export declare function createHubClientForTest(hubUrl: string, tenantId: string): HubClient;
//# sourceMappingURL=client.d.ts.map