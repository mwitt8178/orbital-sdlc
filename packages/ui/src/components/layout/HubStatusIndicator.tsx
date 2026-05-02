/**
 * HubStatusIndicator — topbar widget showing hub connection state.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-04 — Extended with WS subscription state
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Renders:
 *   - green dot  — HTTP hub connected AND WS subscriptions active
 *   - yellow dot — connecting / reconnecting WS
 *   - red dot    — hub offline (HTTP error) OR WS down for >60s
 *   - nothing    — no hub configured (hubUrl is null)
 *
 * The dot now incorporates the WS subscription state from useHubWsStore
 * in addition to the HTTP health state from useHubStore. Green requires
 * BOTH to be connected.
 */

import { useHubStore } from '../../store/hub.js'
import { useHubWsStore } from '../../store/hubWs.js'

// ---------------------------------------------------------------------------
// Derived status combining HTTP health + WS connection
// ---------------------------------------------------------------------------

type VisualStatus = 'connected' | 'reconnecting' | 'offline'

function deriveVisualStatus(
  httpStatus: string,
  wsStatus: string,
  wsIsDown: boolean,
): VisualStatus {
  // Red: HTTP error, or WS has been down >60s
  if (httpStatus === 'error' || httpStatus === 'disconnected' || wsIsDown) return 'offline'
  // Green: HTTP connected AND WS connected with active subscriptions
  if (httpStatus === 'connected' && wsStatus === 'connected') return 'connected'
  // Yellow: anything else (connecting, reconnecting)
  return 'reconnecting'
}

const DOT_CLASS: Record<VisualStatus, string> = {
  connected: 'bg-emerald-500',
  reconnecting: 'bg-amber-400 animate-pulse',
  offline: 'bg-red-500',
}

const LABEL: Record<VisualStatus, string> = {
  connected: 'Hub',
  reconnecting: 'Reconnecting...',
  offline: 'Hub offline',
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return url.slice(0, 30)
  }
}

/**
 * HubStatusIndicator — used in TopBar when ORBITAL_HUB_URL is configured.
 *
 * Reads from the hub Zustand store (HTTP health) and hubWs Zustand store
 * (WS connection). Green = both healthy; yellow = reconnecting; red = down.
 */
export function HubStatusIndicator() {
  const httpStatus = useHubStore((s) => s.status)
  const hubUrl = useHubStore((s) => s.hubUrl)
  const lastSyncAt = useHubStore((s) => s.lastSyncAt)
  const errorMessage = useHubStore((s) => s.errorMessage)

  const wsStatus = useHubWsStore((s) => s.status)
  const wsIsDown = useHubWsStore((s) => s.isDown)
  const wsLastConnected = useHubWsStore((s) => s.lastConnectedAt)

  // Render nothing when hub is not configured.
  if (!hubUrl) return null

  const visual = deriveVisualStatus(httpStatus, wsStatus, wsIsDown)
  const dotClass = DOT_CLASS[visual]
  const label = LABEL[visual]

  const hostname = truncateUrl(hubUrl)

  const syncLabel = lastSyncAt
    ? `Last HTTP sync ${new Date(lastSyncAt).toLocaleTimeString()}`
    : 'Never synced'
  const wsLabel = wsLastConnected
    ? `WS last connected ${new Date(wsLastConnected).toLocaleTimeString()}`
    : wsStatus === 'connected'
      ? 'WS connected'
      : 'WS not connected'

  const title =
    visual === 'connected'
      ? `Connected to ${hubUrl}\n${syncLabel}\n${wsLabel}`
      : visual === 'offline'
        ? `Hub offline: ${errorMessage ?? 'connection lost'}\n${hubUrl}`
        : `Reconnecting to ${hubUrl}\n${wsLabel}`

  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs"
      title={title}
      aria-label={`Hub status: ${label}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${dotClass}`}
        aria-hidden="true"
      />
      <span className="font-medium text-slate-600">
        {visual === 'connected' ? hostname : label}
      </span>
    </div>
  )
}
