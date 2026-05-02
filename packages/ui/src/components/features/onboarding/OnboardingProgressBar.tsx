/**
 * OnboardingProgressBar — labelled dot progression for the wizard.
 */

import clsx from 'clsx'

interface Step {
  id: string
  label: string
}

interface Props {
  steps: Step[]
  currentIndex: number
}

export function OnboardingProgressBar({ steps, currentIndex }: Props) {
  return (
    <nav aria-label="Wizard progress">
      <ol className="flex items-center justify-center gap-2" role="list">
        {steps.map((step, index) => {
          const isComplete = index < currentIndex
          const isCurrent = index === currentIndex
          return (
            <li
              key={step.id}
              role="listitem"
              aria-current={isCurrent ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              <div
                className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                  isComplete && 'bg-brand-600 text-white',
                  isCurrent && 'bg-brand-100 text-brand-700 ring-2 ring-brand-600',
                  !isComplete && !isCurrent && 'bg-slate-100 text-slate-400',
                )}
                aria-hidden="true"
              >
                {isComplete ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={clsx(
                  'hidden text-xs font-medium md:inline',
                  isCurrent ? 'text-slate-900' : 'text-slate-400',
                )}
              >
                {step.label}
              </span>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'mx-1 h-px w-6 md:w-12',
                    isComplete ? 'bg-brand-600' : 'bg-slate-200',
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
