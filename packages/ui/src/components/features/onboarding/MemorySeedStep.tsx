/**
 * MemorySeedStep — Flow B step 4: review the memory entries the analyzer
 * inferred and confirm the write to project_memory_entries.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { useMemo } from 'react'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'
import type { AnalysisReport } from './CodebaseAnalysisStep.js'

interface Props {
  report: AnalysisReport | null
  onConfirm: () => void
  onSkip: () => void
  busy: boolean
}

export function MemorySeedStep({ report, onConfirm, onSkip, busy }: Props) {
  const groups = useMemo(() => {
    const out: Record<string, AnalysisReport['inferredMemoryEntries']> = {}
    for (const e of report?.inferredMemoryEntries ?? []) {
      if (!out[e.kind]) out[e.kind] = []
      out[e.kind]!.push(e)
    }
    return out
  }, [report])

  if (!report) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Seed memory</h1>
        <p className="mt-2 text-sm text-slate-500">
          Analysis hasn't completed yet. Go back and run the analyzer first.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Seed memory</h1>
        <TimeEstimateBadge estSeconds={60} />
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Review the {report.inferredMemoryEntries.length} entries the analyzer
        inferred. They'll be written to project memory and surface on every
        agent brief.
      </p>

      <div className="space-y-4">
        {Object.entries(groups).map(([kind, entries]) => (
          <details key={kind} open className="rounded-md border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              {kind} ({entries.length})
            </summary>
            <ul className="mt-3 space-y-2 text-sm text-slate-700">
              {entries.slice(0, 6).map((e, idx) => (
                <li key={idx} className="rounded border border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="font-medium">{e.title}</p>
                  <p className="mt-0.5 text-xs text-slate-600">{e.body.slice(0, 240)}{e.body.length > 240 ? '…' : ''}</p>
                </li>
              ))}
              {entries.length > 6 && (
                <li className="px-3 py-1 text-xs text-slate-500">
                  +{entries.length - 6} more — review in /memory after onboarding.
                </li>
              )}
            </ul>
          </details>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? 'Seeding…' : 'Confirm + seed'}
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-slate-500 underline hover:text-slate-800"
        >
          Skip — seed later from /memory
        </button>
      </div>
    </div>
  )
}
