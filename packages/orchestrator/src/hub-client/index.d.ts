/**
 * hub-client/index.ts — Process singleton for the hub client.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Usage in routers:
 *   import { getHubClient } from '../../hub-client/index.js'
 *   const hub = getHubClient()
 *   if (hub !== null) { ... proxy to hub ... } else { ... local Postgres ... }
 *
 * Boot (index.ts) calls initHubClient() once. Tests call resetHubClient() to
 * clear the singleton between runs.
 */
import { createHubClientForTest } from './client.js';
import type { HubClient } from './client.js';
import type { HubStatus } from './types.js';
export type { HubClient, HubStatus };
export { createHubClientForTest };
export * from './types.js';
export * from './client.js';
export * from './outbox.js';
export * from './subscriptions.js';
export * from './ws-client.js';
/**
 * getHubClient — return the process singleton hub client, or null if no hub
 * is configured. Returns null (not undefined) when hub is explicitly absent.
 *
 * Lazily initialised from env on first call.
 */
export declare function getHubClient(): HubClient | null;
/**
 * initHubClient — explicitly set the singleton. Called at boot or in tests.
 * Pass null to explicitly mark "no hub".
 */
export declare function initHubClient(client: HubClient | null): void;
/**
 * resetHubClient — clear the singleton so the next getHubClient() call
 * re-reads the env. Used in tests.
 */
export declare function resetHubClient(): void;
//# sourceMappingURL=index.d.ts.map