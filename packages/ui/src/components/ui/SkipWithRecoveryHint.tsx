/**
 * SkipWithRecoveryHint — a small "Skip — you can do this later in
 * Settings → <where>" affordance shown beside non-required onboarding steps.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #4: skip with a recovery path named.
 */

import clsx from 'clsx'
import type { MouseEvent } from 'react'

interface Props {
  /** "Settings → Models", "Settings → GitHub", etc. */
  recoveryPath: string
  onSkip: () => void
  className?: string
  label?: string
}

export function SkipWithRecoveryHint({
  recoveryPath,
  onSkip,
  className,
  label = 'Skip',
}: Props) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    onSkip()
  }
  return (
    <p
      className={clsx('mt-2 text-xs text-slate-500', className)}
      data-testid="skip-with-recovery"
    >
      <button
        type="button"
        onClick={handleClick}
        className="font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {label}
      </button>{' '}
      — you can do this later in <span className="font-medium">{recoveryPath}</span>.
    </p>
  )
}
