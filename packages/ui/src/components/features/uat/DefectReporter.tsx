/**
 * DefectReporter — modal for reporting a defect against a specific AC.
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Props:
 *   taskId       — the author task that produced the failing AC
 *   acId         — the AC that failed
 *   acText       — AC text (auto-filled into header)
 *   iterationCount — current iteration count; controls limit warning
 *   onClose      — called after successful submit or explicit cancel
 *
 * On submit:
 *   → uat.defects.report mutation
 *   → shows confirmation "Defect reported. Iteration N will start automatically."
 *   → or limit warning if iterationCount >= 3
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ITERATION_LIMIT = 3

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DefectReporterProps {
  taskId: string
  acId: string
  acText: string
  iterationCount: number
  onClose: () => void
}

type Severity = 'low' | 'medium' | 'high' | 'critical'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Modal for reporting a defect against an AC row. Submits via
 * uat.defects.report → emits DefectReported → triggers re-spawn loop.
 */
export function DefectReporter({ taskId, acId, acText, iterationCount, onClose }: DefectReporterProps) {
  const [reproSteps, setReproSteps] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [suggestedFix, setSuggestedFix] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const mutation = trpc.uat.defects.report.useMutation({
    onSuccess: () => {
      setSubmitted(true)
    },
  })

  const atLimit = iterationCount >= ITERATION_LIMIT
  const nextIteration = iterationCount + 1

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!reproSteps.trim()) return
    mutation.mutate({
      task_id: taskId,
      ac_id: acId,
      ac_text: acText,
      reproduction_steps: reproSteps.trim(),
      severity,
      suggested_fix: suggestedFix.trim() || undefined,
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="defect-reporter-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2
              id="defect-reporter-title"
              className="text-base font-semibold text-slate-900"
            >
              Report defect on AC
            </h2>
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{acText}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close defect reporter"
            className="ml-4 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Iteration limit warning */}
        {atLimit && (
          <div
            role="alert"
            className="mx-5 mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            This task has reached the iteration limit ({ITERATION_LIMIT} iterations). Reporting
            this defect will require human escalation — it will NOT trigger an automatic
            re-spawn.
          </div>
        )}

        {/* Success state */}
        {submitted && (
          <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-900">Defect reported.</p>
            {atLimit ? (
              <p className="text-xs text-amber-700">Human escalation required — no auto re-spawn.</p>
            ) : (
              <p className="text-xs text-slate-500">
                Iteration {nextIteration} will start automatically.
              </p>
            )}
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {/* Form */}
        {!submitted && (
          <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
            {/* Reproduction steps */}
            <div>
              <label
                htmlFor="defect-repro"
                className="block text-xs font-medium text-slate-700"
              >
                Reproduction steps
                <span className="ml-1 text-rose-500" aria-hidden="true">*</span>
              </label>
              <textarea
                id="defect-repro"
                autoFocus
                rows={4}
                value={reproSteps}
                onChange={(e) => setReproSteps(e.target.value)}
                placeholder="Steps to reproduce the defect (markdown supported)"
                className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                required
                aria-required="true"
              />
            </div>

            {/* Severity */}
            <fieldset>
              <legend className="text-xs font-medium text-slate-700">Severity</legend>
              <div className="mt-1.5 flex gap-3">
                {(['low', 'medium', 'high', 'critical'] as Severity[]).map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="radio"
                      name="severity"
                      value={s}
                      checked={severity === s}
                      onChange={() => setSeverity(s)}
                      className="accent-brand-600"
                    />
                    <span
                      className={`text-xs font-medium capitalize ${
                        s === 'critical'
                          ? 'text-red-700'
                          : s === 'high'
                            ? 'text-rose-600'
                            : s === 'medium'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                      }`}
                    >
                      {s}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Suggested fix (optional) */}
            <div>
              <label
                htmlFor="defect-fix"
                className="block text-xs font-medium text-slate-700"
              >
                Suggested fix{' '}
                <span className="text-slate-400">(optional)</span>
              </label>
              <textarea
                id="defect-fix"
                rows={2}
                value={suggestedFix}
                onChange={(e) => setSuggestedFix(e.target.value)}
                placeholder="Optional hint for the author (markdown supported)"
                className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            {mutation.error && (
              <p className="text-xs text-rose-600" role="alert">
                {mutation.error.message}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!reproSteps.trim() || mutation.isPending}
              >
                {mutation.isPending ? 'Reporting…' : 'Report defect'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
