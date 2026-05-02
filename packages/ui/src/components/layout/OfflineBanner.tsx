/**
 * OfflineBanner — full-width top banner shown when hub WS down >60s.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Round 7-06 — Extended with pending count + click-to-view affordance
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Appears at the top of the viewport when:
 *   - Hub WS has been disconnected for more than 60 seconds.
 *
 * Shows:
 *   - "Offline — N pending changes" with click-to-view-pending affordance.
 *   - "Reconnecting to hub..." message with last-success timestamp.
 *   - Cleared (banner disappears) when reconnect succeeds.
 *
 * Round 7-06 additions:
 *   - Shows number of pending mutations from pendingMutations store.
 *   - "View pending" button opens PendingMutationsPanel (via callback prop or
 *     by publishing to a global panel-open signal via store).
 *   - Uses useHubConnection() hook for clean aggregated state.
 *
 * Reads from useHubWsStore.isDown + downSince + lastConnectedAt.
 * Uses Tailwind v4 utility classes only (no @apply).
 */

import { useHubWsStore } from '../../store/hubWs.js'
import { useHubConnection } from '../../hooks/useHubConnection.js'
import { usePendingMutationsPanelStore } from '../../store/pendingMutationsPanel.js'

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'unknown'
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export function OfflineBanner() {
  const isDown = useHubWsStore((s) => s.isDown)
  const lastConnectedAt = useHubWsStore((s) => s.lastConnectedAt)
  const status = useHubWsStore((s) => s.status)
  const { totalQueuedCount } = useHubConnection()
  const openPanel = usePendingMutationsPanelStore((s) => s.open)

  if (!isDown) return null

  const lastSuccess = formatTimestamp(lastConnectedAt)
  const isReconnecting = status === 'reconnecting' || status === 'connecting'

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex w-full items-center justify-between bg-amber-50 px-4 py-2 text-sm text-amber-900 border-b border-amber-200"
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"
          aria-hidden="true"
        />
        <span className="font-medium">
          {isReconnecting ? 'Reconnecting to hub...' : 'Hub disconnected'}
        </span>
        {lastConnectedAt && (
          <span className="text-amber-700">
            Last connected at {lastSuccess}
          </span>
        )}
        {totalQueuedCount > 0 && (
          <span className="text-amber-800 font-medium">
            — {totalQueuedCount} pending change{totalQueuedCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {totalQueuedCount > 0 && (
          <button
            type="button"
            onClick={() => openPanel()}
            className="rounded px-2 py-0.5 text-xs font-medium text-amber-800 underline hover:text-amber-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
            aria-label={`View ${totalQueuedCount} pending change${totalQueuedCount !== 1 ? 's' : ''}`}
          >
            View pending
          </button>
        )}
        <span className="text-xs text-amber-600">
          Cached data is read-only. Mutations will retry on reconnect.
        </span>
      </div>
    </div>
  )
}
