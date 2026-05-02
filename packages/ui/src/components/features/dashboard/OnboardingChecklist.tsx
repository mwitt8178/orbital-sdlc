/**
 * OnboardingChecklist — guided next-steps panel that replaces empty KPIs
 * for users who have just completed the wizard but have no real data yet.
 *
 * Once all five items are checked, the panel collapses to a "Setup
 * complete · view tour" pill (rendered by the parent — this component
 * only owns the checklist itself).
 */

import { Link } from 'react-router-dom'
import clsx from 'clsx'

export interface ChecklistState {
  hasMode: boolean
  hasFirstVision: boolean
  hasApprovedPlan: boolean
  hasStartedSprint: boolean
  hasReviewedAudit: boolean
}

interface Props {
  state: ChecklistState
}

interface Item {
  key: keyof ChecklistState
  label: string
  to: string
  cta: string
  /** When false, the row is greyed and not clickable. */
  unlockedWhen: (s: ChecklistState) => boolean
}

const ITEMS: Item[] = [
  {
    key: 'hasMode',
    label: 'Connect Anthropic (live mode) or load sample (demo)',
    to: '/welcome',
    cta: 'Open setup',
    unlockedWhen: () => true,
  },
  {
    key: 'hasFirstVision',
    label: 'Define your first vision',
    to: '/vision',
    cta: 'Start vision',
    unlockedWhen: () => true,
  },
  {
    key: 'hasApprovedPlan',
    label: 'Approve the sprint plan',
    to: '/ceremonies',
    cta: 'Open planning',
    unlockedWhen: (s) => s.hasFirstVision,
  },
  {
    key: 'hasStartedSprint',
    label: 'Start your first sprint',
    to: '/',
    cta: 'Start sprint',
    unlockedWhen: (s) => s.hasApprovedPlan,
  },
  {
    key: 'hasReviewedAudit',
    label: 'Review the audit log',
    to: '/audit',
    cta: 'Open audit',
    unlockedWhen: () => true,
  },
]

export function OnboardingChecklist({ state }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-card">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Get started</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            A few quick steps to see Orbital end-to-end.
          </p>
        </div>
        <span
          className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-700"
          aria-label="Completion ratio"
        >
          {countComplete(state)} / {ITEMS.length}
        </span>
      </header>

      <ol className="space-y-2" role="list">
        {ITEMS.map((item) => {
          const done = state[item.key]
          const unlocked = item.unlockedWhen(state)
          return (
            <li
              key={item.key}
              role="listitem"
              className={clsx(
                'flex items-center justify-between rounded-md border px-3 py-2 transition-colors',
                done
                  ? 'border-emerald-200 bg-emerald-50'
                  : unlocked
                    ? 'border-slate-200 bg-white hover:bg-slate-50'
                    : 'border-slate-200 bg-slate-50 opacity-60',
              )}
            >
              <div className="flex items-center gap-3">
                <CheckIndicator done={done} />
                <span
                  className={clsx(
                    'text-sm',
                    done ? 'text-slate-700 line-through' : 'text-slate-900',
                  )}
                >
                  {item.label}
                </span>
              </div>
              {!done && unlocked && (
                <Link
                  to={item.to}
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  {item.cta} →
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function countComplete(state: ChecklistState): number {
  let n = 0
  for (const item of ITEMS) {
    if (state[item.key]) n++
  }
  return n
}

function CheckIndicator({ done }: { done: boolean }) {
  if (done) {
    return (
      <span
        aria-label="completed"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    )
  }
  return (
    <span
      aria-label="not complete"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-slate-300 bg-white"
    />
  )
}
