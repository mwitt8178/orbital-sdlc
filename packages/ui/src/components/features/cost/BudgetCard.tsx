/**
 * BudgetCard — shows a single scope budget (install / project / sprint).
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'

interface BudgetCardProps {
  scope: 'install' | 'project' | 'sprint'
  scopeId: string
  label: string
  runningCostUsd: number
  hardCapUsd: number | null
  softThresholdPct: number
  onSoft: string
  onHard: string
  /** Whether the current user can edit budgets. */
  canEdit?: boolean
  onUpdated?: () => void
}

export function BudgetCard({
  scope,
  scopeId,
  label,
  runningCostUsd,
  hardCapUsd,
  softThresholdPct,
  onSoft,
  onHard,
  canEdit = false,
  onUpdated,
}: BudgetCardProps) {
  const [editing, setEditing] = useState(false)
  const [newCap, setNewCap] = useState(String(hardCapUsd ?? ''))
  const [newSoftPct, setNewSoftPct] = useState(String(softThresholdPct))

  const setBudget = trpc.cost.setBudget.useMutation({
    onSuccess: () => {
      setEditing(false)
      onUpdated?.()
    },
  })

  const pct = hardCapUsd && hardCapUsd > 0 ? runningCostUsd / hardCapUsd : 0
  const pctClamped = Math.min(1, Math.max(0, pct))
  const pctDisplay = Math.round(pctClamped * 100)

  const fillColor =
    pctClamped >= 1.0
      ? 'bg-red-500'
      : pctClamped >= 0.8
        ? 'bg-amber-500'
        : pctClamped >= 0.5
          ? 'bg-amber-400'
          : 'bg-emerald-500'

  const statusText =
    pctClamped >= 1.0
      ? 'Over cap'
      : pctClamped >= 0.8
        ? 'Approaching cap'
        : 'On track'

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {scope}
          </span>
          <p className="mt-0.5 text-sm font-medium text-slate-900">{label}</p>
        </div>
        <span
          className={clsx(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            pctClamped >= 1.0
              ? 'bg-red-100 text-red-700'
              : pctClamped >= 0.8
                ? 'bg-amber-100 text-amber-700'
                : 'bg-emerald-100 text-emerald-700',
          )}
        >
          {statusText}
        </span>
      </div>

      <div className="mb-3">
        <div className="mb-1 flex justify-between text-xs text-slate-500">
          <span>Spent</span>
          <span className="font-mono">
            ${runningCostUsd.toFixed(2)}
            {hardCapUsd != null && <> / ${hardCapUsd.toFixed(2)}</>}
            {hardCapUsd != null && <> ({pctDisplay}%)</>}
          </span>
        </div>
        <div
          role="meter"
          aria-valuenow={pctDisplay}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pctDisplay}% of ${scope} budget used`}
          className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${fillColor}`}
            style={{ width: `${pctDisplay}%` }}
          />
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-slate-50 px-2 py-1.5">
          <span className="text-slate-500">Soft threshold</span>
          <p className="font-mono font-medium text-slate-700">{softThresholdPct}%</p>
        </div>
        <div className="rounded bg-slate-50 px-2 py-1.5">
          <span className="text-slate-500">On hard</span>
          <p className="font-mono font-medium text-slate-700">{onHard}</p>
        </div>
        <div className="rounded bg-slate-50 px-2 py-1.5">
          <span className="text-slate-500">On soft</span>
          <p className="font-mono font-medium text-slate-700">{onSoft}</p>
        </div>
      </div>

      {canEdit && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Edit budget
        </button>
      )}

      {canEdit && editing && (
        <div className="space-y-2">
          <div>
            <label htmlFor={`cap-${scope}`} className="mb-0.5 block text-xs text-slate-600">
              Hard cap (USD)
            </label>
            <input
              id={`cap-${scope}`}
              type="number"
              min="0.01"
              step="0.01"
              value={newCap}
              onChange={(e) => setNewCap(e.target.value)}
              className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor={`soft-${scope}`} className="mb-0.5 block text-xs text-slate-600">
              Soft threshold %
            </label>
            <input
              id={`soft-${scope}`}
              type="number"
              min="1"
              max="100"
              step="1"
              value={newSoftPct}
              onChange={(e) => setNewSoftPct(e.target.value)}
              className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={setBudget.isPending}
              onClick={() => {
                const cap = parseFloat(newCap)
                const soft = parseInt(newSoftPct, 10)
                if (isNaN(cap) || cap <= 0) return
                setBudget.mutate({
                  scope,
                  scopeId,
                  hardCapUsd: cap,
                  softThresholdPct: isNaN(soft) ? 80 : soft,
                })
              }}
              className="flex-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
            >
              {setBudget.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Cancel
            </button>
          </div>
          {setBudget.isError && (
            <p className="text-xs text-red-600">{setBudget.error.message}</p>
          )}
        </div>
      )}
    </div>
  )
}
