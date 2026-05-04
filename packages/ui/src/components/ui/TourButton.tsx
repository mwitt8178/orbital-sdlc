/**
 * TourButton — persistent "Tour" affordance available from the topbar after
 * onboarding. Click → guided overlay that walks through the major UI
 * surfaces (sidebar nav, defect reporter, operator badge, channels).
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #10: persistent Tour button in topbar.
 */

import clsx from 'clsx'
import { useState } from 'react'

interface Props {
  className?: string
}

interface TourStop {
  title: string
  body: string
}

const STOPS: TourStop[] = [
  {
    title: 'Backlog',
    body:
      'All in-flight stories live here. Sorted by sprint, with full Monday + GitHub PR cross-references.',
  },
  {
    title: 'Channels',
    body:
      'Where agents talk to each other. Escalations, hand-offs, and peer questions are all auditable.',
  },
  {
    title: 'Cost',
    body:
      'Live token spend per worker. Hard caps prevent any sprint from going over budget without explicit approval.',
  },
  {
    title: 'Audit',
    body:
      'Every event your agents have emitted, in order. The source of truth for everything that happened.',
  },
  {
    title: 'Memory',
    body:
      'Cross-sprint project memory. Decisions, conventions, glossary, anti-patterns — agents auto-load relevant entries.',
  },
  {
    title: 'Defect reporter',
    body:
      'Bottom-right floating button. File a defect against any AC and the same author re-spawns to fix it.',
  },
]

export function TourButton({ className }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  const stop = STOPS[step] ?? STOPS[0]!

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setStep(0)
          setOpen(true)
        }}
        className={clsx(
          'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          className,
        )}
        aria-label="Take a tour of the UI"
        data-testid="tour-button"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        Tour
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tour-stop-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Step {step + 1} of {STOPS.length}
            </p>
            <h2
              id="tour-stop-title"
              className="mt-1 text-lg font-semibold text-slate-900"
            >
              {stop.title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">{stop.body}</p>
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                Close
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={step === 0}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Back
                </button>
                {step < STOPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => s + 1)}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
