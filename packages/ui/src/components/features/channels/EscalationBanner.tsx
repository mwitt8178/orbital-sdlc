/**
 * EscalationBanner — prominent banner shown at the top of Backlog/UAT/Channels
 * when there are unresolved escalations in the active sprint.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Props:
 *   sprintId    — current sprint UUID; used to query channels.escalations
 *   onViewAll   — callback when "view all" is clicked (navigate to Channels)
 */

import { useNavigate } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EscalationBannerProps {
  sprintId: string | null | undefined
  /** Optional override for navigation (defaults to /channels). */
  onViewAll?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EscalationBanner({ sprintId, onViewAll }: EscalationBannerProps) {
  const navigate = useNavigate()

  const { data } = trpc.channel.escalations.useQuery(
    { sprint_id: sprintId ?? '', unresolved_only: false },
    {
      enabled: !!sprintId,
      refetchInterval: 15_000,
    },
  )

  const escalations = data?.escalations ?? []
  if (escalations.length === 0) return null

  const handleViewAll = () => {
    if (onViewAll) {
      onViewAll()
    } else {
      navigate('/channels')
    }
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-amber-600"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-sm font-medium text-amber-800">
          {escalations.length === 1
            ? '1 active escalation'
            : `${escalations.length} active escalations`}
          {' · agents awaiting resolution'}
        </span>
      </div>
      <button
        type="button"
        onClick={handleViewAll}
        className="text-sm font-medium text-amber-700 underline-offset-2 hover:text-amber-900 hover:underline"
      >
        view all
      </button>
    </div>
  )
}
