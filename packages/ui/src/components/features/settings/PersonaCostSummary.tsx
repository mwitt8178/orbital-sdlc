/**
 * PersonaCostSummary — per-project spend by persona, week vs month.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * Joins worker_runs with the persona slug derived from branch prefix.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

type Range = 'week' | 'month'

export function PersonaCostSummary() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)
  const [range, setRange] = useState<Range>('week')

  if (!activeProjectId) {
    return <p className="text-sm text-slate-600">Select a project to see spend by persona.</p>
  }

  return <Inner projectId={activeProjectId} range={range} setRange={setRange} />
}

interface Bucket {
  personaSlug: string
  usdCents: number
}

function Inner({
  projectId,
  range,
  setRange,
}: {
  projectId: string
  range: Range
  setRange: (r: Range) => void
}) {
  const cost = (trpc as unknown as {
    projectPersonas: {
      costByPersona: { useQuery: (i: { projectId: string; range: Range }) => { data?: Bucket[]; isLoading: boolean; error: { message: string } | null } }
    }
  }).projectPersonas.costByPersona.useQuery({ projectId, range })

  if (cost.isLoading) return <Skeleton rows={5} />
  if (cost.error) return <ErrorMessage title="Could not load cost" message={cost.error.message} />

  const rows = cost.data ?? []
  const total = rows.reduce((acc, r) => acc + r.usdCents, 0)
  const max = Math.max(1, ...rows.map((r) => r.usdCents))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Spend on this project for the past {range === 'week' ? '7 days' : '30 days'}.
        </p>
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200">
          {(['week', 'month'] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-xs font-medium ${
                range === r ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {r === 'week' ? 'This week' : 'This month'}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-xs uppercase tracking-wide text-slate-500">Total</span>
          <span className="text-lg font-semibold text-slate-900">{formatUsd(total)}</span>
        </div>
        <ul className="space-y-2">
          {rows.length === 0 ? (
            <li className="text-xs text-slate-500">No worker runs yet for this period.</li>
          ) : (
            rows.map((r) => (
              <li key={r.personaSlug} className="flex items-center gap-3">
                <span className="w-32 truncate font-mono text-xs text-slate-700">
                  {r.personaSlug}
                </span>
                <span className="flex-1">
                  <span
                    className="block h-2 rounded bg-brand-500"
                    style={{ width: `${(r.usdCents / max) * 100}%`, minWidth: r.usdCents > 0 ? '4px' : '0' }}
                  />
                </span>
                <span className="w-20 text-right text-xs font-medium text-slate-700">
                  {formatUsd(r.usdCents)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

function formatUsd(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 100) return `$${dollars.toFixed(0)}`
  return `$${dollars.toFixed(2)}`
}
