/**
 * DoneStep — final summary card shown at the end of any flow.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #1 + #2: shows what was done — Monday + GitHub +
 * memory + system-teaching audit trail.
 */

import clsx from 'clsx'
import { Button } from '../../ui/Button.js'

export interface DoneStepData {
  projectName: string
  /** "PROJECT", "INFRASTRUCTURE", etc. → list of bullet strings. */
  sections: Array<{ title: string; items: string[] }>
}

interface Props {
  data: DoneStepData
  onLaunch: () => void
  onTour: () => void
  onWatchInspector: () => void
  className?: string
}

export function DoneStep({ data, onLaunch, onTour, onWatchInspector, className }: Props) {
  return (
    <div className={clsx(className)}>
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          ✓
        </span>
        <h1 className="text-2xl font-bold text-slate-900">You're set up</h1>
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Here's everything that just happened on <span className="font-medium">{data.projectName}</span>:
      </p>

      <div className="space-y-5">
        {data.sections.map((section) => (
          <div key={section.title}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {section.title}
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
              {section.items.map((item, idx) => (
                <li key={`${section.title}-${idx}`} className="flex items-start gap-2">
                  <span className="mt-0.5 text-emerald-600">✓</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button variant="primary" size="lg" onClick={onLaunch}>
          Launch
        </Button>
        <Button variant="secondary" size="lg" onClick={onWatchInspector}>
          Watch the live inspector
        </Button>
        <Button variant="ghost" size="lg" onClick={onTour}>
          Tour the UI
        </Button>
      </div>
    </div>
  )
}
