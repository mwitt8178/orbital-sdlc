/**
 * OnboardingProgressBar — segmented progress with current-step caption.
 *
 * Two modes:
 *   - default (md+): horizontal dot rail with full labels
 *   - compact (mobile): "Step 3 of 7 · Connect tools" line + a thin track bar
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import clsx from 'clsx'
import { motion } from 'framer-motion'

interface Step {
  id: string
  label: string
}

interface Props {
  steps: Step[]
  currentIndex: number
  /** Compact horizontal-bar variant for narrow viewports. */
  compact?: boolean
}

export function OnboardingProgressBar({ steps, currentIndex, compact = false }: Props) {
  if (steps.length <= 1) return null

  const total = steps.length
  const current = Math.min(currentIndex, total - 1)
  const pct = Math.round(((current + 1) / total) * 100)
  const currentLabel = steps[current]?.label ?? ''

  if (compact) {
    return (
      <div className="flex items-center gap-3" aria-label="Wizard progress">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700">
              Step {current + 1} of {total}
            </span>
            <span className="truncate text-slate-500">{currentLabel}</span>
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <nav aria-label="Wizard progress">
      <ol className="flex items-center gap-1.5" role="list">
        {steps.map((step, index) => {
          const isComplete = index < current
          const isCurrent = index === current
          return (
            <li
              key={step.id}
              role="listitem"
              aria-current={isCurrent ? 'step' : undefined}
              className="flex items-center gap-1.5"
            >
              <div
                className={clsx(
                  'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                  isComplete && 'bg-brand-600 text-white',
                  isCurrent && 'bg-brand-100 text-brand-700 ring-2 ring-brand-500 ring-offset-2 ring-offset-white',
                  !isComplete && !isCurrent && 'bg-slate-100 text-slate-400',
                )}
                aria-hidden="true"
              >
                {isComplete ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={clsx(
                  'hidden text-xs font-medium lg:inline',
                  isCurrent ? 'text-slate-900' : isComplete ? 'text-slate-600' : 'text-slate-400',
                )}
              >
                {step.label}
              </span>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'h-px w-4 lg:w-8',
                    isComplete ? 'bg-brand-500' : 'bg-slate-200',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
