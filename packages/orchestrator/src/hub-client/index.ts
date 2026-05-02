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

import { createHubClient, createHubClientForTest } from './client.js'
import type { HubClient } from './client.js'
import type { HubStatus } from './types.js'

export type { HubClient, HubStatus }
export { createHubClientForTest }
export * from './types.js'
export * from './client.js'
export * from './outbox.js'
export * from './subscriptions.js'

// Round 7-04 — Hub WS client
// [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
export * from './ws-client.js'

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _hubClient: HubClient | null | undefined = undefined

/**
 * getHubClient — return the process singleton hub client, or null if no hub
 * is configured. Returns null (not undefined) when hub is explicitly absent.
 *
 * Lazily initialised from env on first call.
 */
export function getHubClient(): HubClient | null {
  if (_hubClient === undefined) {
    _hubClient = createHubClient()
  }
  return _hubClient
}

/**
 * initHubClient — explicitly set the singleton. Called at boot or in tests.
 * Pass null to explicitly mark "no hub".
 */
export function initHubClient(client: HubClient | null): void {
  _hubClient = client
}

/**
 * resetHubClient — clear the singleton so the next getHubClient() call
 * re-reads the env. Used in tests.
 */
export function resetHubClient(): void {
  _hubClient = undefined
}
