/**
 * TimeEstimateBadge — small "~2 min" badge shown at the top of every wizard
 * step.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria: time estimates per step.
 */

import clsx from 'clsx'

interface Props {
  /** Estimate in seconds. */
  estSeconds: number
  className?: string
}

export function TimeEstimateBadge({ estSeconds, className }: Props) {
  const text = formatEstimate(estSeconds)
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600',
        className,
      )}
      role="note"
      aria-label={`Estimated time: ${text}`}
      data-testid="time-estimate-badge"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      {text}
    </span>
  )
}

function formatEstimate(estSeconds: number): string {
  if (estSeconds <= 0) return 'instant'
  if (estSeconds < 60) return `~${estSeconds} sec`
  const min = Math.round(estSeconds / 60)
  return min === 1 ? '~1 min' : `~${min} min`
}
