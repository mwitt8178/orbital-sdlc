/**
 * DefectTimeline — vertical timeline of defect iterations for a task.
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Shows:
 *   - Each iteration as a timeline entry with iteration badge, severity chip,
 *     AC text, reproduction steps, and "Mark fixed" action.
 *   - Footer: total iterations · total defects reported.
 *
 * Data: fetched from uat.defects.history(task_id).
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
// Round 7-08 — Operator-Attributed UI: per-iteration "Built by [...]"
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../../identity/OperatorBadge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DefectTimelineProps {
  taskId: string
  /** Show the current iteration count as a live "running" indicator. */
  iterationCount?: number
}

type Severity = 'low' | 'medium' | 'high' | 'critical'

// ---------------------------------------------------------------------------
// Severity chip
// ---------------------------------------------------------------------------

function SeverityChip({ severity }: { severity: Severity }) {
  const colorMap: Record<Severity, string> = {
    critical: 'bg-red-100 text-red-700 border-red-200',
    high: 'bg-rose-100 text-rose-700 border-rose-100',
    medium: 'bg-amber-100 text-amber-700 border-amber-200',
    low: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${colorMap[severity]}`}
    >
      {severity}
    </span>
  )
}

// ---------------------------------------------------------------------------
// MarkFixed button (per-defect)
// ---------------------------------------------------------------------------

function MarkFixedButton({ defectId }: { defectId: string }) {
  const utils = trpc.useUtils()
  const mutation = trpc.uat.defects.markFixed.useMutation({
    onSuccess: () => {
      void utils.uat.defects.history.invalidate()
    },
  })

  return (
    <button
      type="button"
      onClick={() => mutation.mutate({ defect_id: defectId })}
      disabled={mutation.isPending}
      className="text-xs text-emerald-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
    >
      {mutation.isPending ? 'Marking…' : 'Mark fixed'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a vertical timeline of defect iterations for the given task.
 * Empty state shows "No defects reported yet."
 */
export function DefectTimeline({ taskId, iterationCount = 0 }: DefectTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  // Round 7-08 — Operator-Attributed UI: load team members for "built by" attribution
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 60_000 })
  const memberMap = new Map<string, TeamMember>(
    (membersQuery.data ?? []).map((m) => [m.install_id, {
      install_id: m.install_id,
      display_name: m.display_name,
      role: m.role,
      last_seen_at: m.last_seen_at,
      color: m.color,
    }]),
  )

  const historyQuery = trpc.uat.defects.history.useQuery(
    { task_id: taskId },
    { enabled: !!taskId, staleTime: 10_000 },
  )

  if (historyQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton rows={2} />
      </div>
    )
  }

  if (historyQuery.error) {
    return (
      <ErrorMessage
        title="Could not load defect history"
        message={historyQuery.error.message}
      />
    )
  }

  const defects = historyQuery.data?.defects ?? []

  if (defects.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">No defects reported yet.</p>
    )
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="space-y-3">
      <ol className="relative border-l border-slate-200 pl-4" aria-label="Defect iteration history">
        {defects.map((defect) => {
          const isExpanded = expandedIds.has(defect.defect_id)
          const isLast = defect.iteration_number === defects.length
          const isRunning = isLast && iterationCount > 0 && iterationCount === defect.iteration_number

          return (
            <li
              key={defect.defect_id}
              className="relative mb-4 last:mb-0"
            >
              {/* Timeline dot */}
              <span
                aria-hidden="true"
                className={`absolute -left-[1.125rem] flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-white ${
                  isRunning
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-slate-300'
                }`}
              />

              {/* Entry card */}
              <div className="rounded-lg border border-slate-100 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-white">
                      {defect.iteration_number}
                    </span>
                    <SeverityChip severity={defect.severity as Severity} />
                    {isRunning && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
                        Iterating
                      </span>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-slate-400">
                    {new Date(defect.created_at).toLocaleString()}
                  </span>
                </div>

                {/* AC text */}
                <p className="mt-1.5 line-clamp-1 text-xs font-medium text-slate-700">
                  AC: {defect.ac_text}
                </p>

                {/* Expand/collapse repro */}
                <button
                  type="button"
                  onClick={() => toggleExpand(defect.defect_id)}
                  className="mt-1 text-xs text-slate-500 hover:text-slate-700 hover:underline"
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? 'Hide repro' : 'Show repro'}
                </button>

                {isExpanded && (
                  <pre className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
                    {defect.reproduction_steps}
                  </pre>
                )}

                {defect.suggested_fix && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    <span className="font-medium">Suggested fix:</span>{' '}
                    {defect.suggested_fix}
                  </p>
                )}

                {/* Footer row */}
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400">
                      {defect.defect_key}
                    </span>
                    {/* Round 7-08 — show OperatorBadge for the reporter if install_id known */}
                    {(() => {
                      const installId = (defect as Record<string, unknown>)['install_id'] as string | undefined
                      if (installId) {
                        const member = memberMap.get(installId)
                        return (
                          <OperatorBadge
                            installId={installId}
                            member={member}
                            size="sm"
                          />
                        )
                      }
                      return (
                        <span className="text-[10px] text-slate-400">
                          by {defect.reported_by}
                        </span>
                      )
                    })()}
                  </div>
                  <MarkFixedButton defectId={defect.defect_id} />
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {/* Footer summary */}
      <p className="text-[11px] text-slate-400">
        Total iterations: {iterationCount} &middot; Total defects: {defects.length}
      </p>
    </div>
  )
}
