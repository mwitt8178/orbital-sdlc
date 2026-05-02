/**
 * hooks/useHubConnection.ts — React hook exposing hub connection state +
 * queued mutation count.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Aggregates:
 *   - WS connection status (from hubWs store)
 *   - Whether the hub is considered "down" (>60s disconnected)
 *   - Queued mutation count from pendingMutations store
 *   - Whether we are currently in offline mode (hub unreachable)
 *
 * Used by OfflineBanner (to show count), PendingMutationsPanel (to show the
 * list), and any component that needs to disable write operations while offline.
 *
 * The hook is a pure read of Zustand stores — no side effects, no network calls.
 */

import { useHubWsStore } from '../store/hubWs.js'
import { usePendingMutationsStore } from '../store/pendingMutations.js'

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface HubConnectionInfo {
  /** WS connection status. */
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  /** Whether hub has been down for >60s (triggers offline banner). */
  isDown: boolean
  /** True when isDown=true or status is disconnected/reconnecting. */
  isOffline: boolean
  /** ISO timestamp of last successful connection. Null before first connect. */
  lastConnectedAt: string | null
  /** ISO timestamp when the connection went down. Null when connected. */
  downSince: string | null
  /** Number of mutations queued in the local outbox (pending + retrying). */
  pendingCount: number
  /** Number of permanently failed mutations requiring operator resolution. */
  failedCount: number
  /** Total queued (pending + retrying + failed). */
  totalQueuedCount: number
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useHubConnection — read hub WS connection state + pending mutation counts.
 *
 * Re-renders when any of the tracked state changes (connection status,
 * pending/failed counts). Stable reference — components can call this
 * from render without concern.
 *
 * @returns HubConnectionInfo
 */
export function useHubConnection(): HubConnectionInfo {
  const status = useHubWsStore((s) => s.status)
  const isDown = useHubWsStore((s) => s.isDown)
  const lastConnectedAt = useHubWsStore((s) => s.lastConnectedAt)
  const downSince = useHubWsStore((s) => s.downSince)

  const pendingCount = usePendingMutationsStore((s) => s.pendingCount)
  const failedCount = usePendingMutationsStore((s) => s.failedCount)
  const totalQueuedCount = pendingCount + failedCount

  const isOffline = isDown || status === 'disconnected' || status === 'reconnecting'

  return {
    status,
    isDown,
    isOffline,
    lastConnectedAt,
    downSince,
    pendingCount,
    failedCount,
    totalQueuedCount,
  }
}
