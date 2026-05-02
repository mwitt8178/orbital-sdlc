/**
 * PresenceIndicator — online/offline dot with tooltip.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * An install is considered "online" when last_seen_at is within 90 seconds
 * of now (matching the architecture spec).
 */

import { useState } from 'react'
import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresenceIndicatorProps {
  /** ISO timestamp of last heartbeat, or null if never seen. */
  lastSeenAt: string | null | undefined
  /** Display name for tooltip. */
  displayName?: string
  /** Size of the dot. Default 'md'. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const ONLINE_THRESHOLD_MS = 90_000

export function isOnline(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS
}

function formatLastSeen(lastSeenAt: string | null | undefined): string {
  if (!lastSeenAt) return 'Never seen'
  const ms = Date.now() - new Date(lastSeenAt).getTime()
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A small colored dot indicating online/offline status.
 * Shows a tooltip on hover with last-seen time.
 */
export function PresenceIndicator({
  lastSeenAt,
  displayName,
  size = 'md',
  className,
}: PresenceIndicatorProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const online = isOnline(lastSeenAt)

  const sizeMap = {
    sm: 'h-1.5 w-1.5',
    md: 'h-2.5 w-2.5',
    lg: 'h-3.5 w-3.5',
  }

  const tooltip = displayName
    ? `${displayName}: ${online ? 'Online' : formatLastSeen(lastSeenAt)}`
    : online
      ? 'Online'
      : formatLastSeen(lastSeenAt)

  return (
    <span
      className={clsx('relative inline-flex shrink-0 items-center', className)}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      aria-label={tooltip}
    >
      <span
        className={clsx(
          'rounded-full',
          sizeMap[size],
          online ? 'bg-emerald-500' : 'bg-slate-300',
        )}
        aria-hidden="true"
      />
      {tooltipVisible && (
        <span
          className="absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow"
          role="tooltip"
        >
          {tooltip}
        </span>
      )}
    </span>
  )
}
