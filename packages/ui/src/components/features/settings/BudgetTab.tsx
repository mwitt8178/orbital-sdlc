/**
 * BudgetTab — Settings → Budget tab.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Lets operators set default budget caps for new projects/sprints,
 * and toggle auto-pause on hard cap breach.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'

export function BudgetTab() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  const [hardCap, setHardCap] = useState('10.00')
  const [softPct, setSoftPct] = useState('80')
  const [onSoft, setOnSoft] = useState<'alert' | 'pause' | 'none'>('alert')
  const [onHard, setOnHard] = useState<'pause' | 'kill' | 'alert_only'>('pause')

  const setBudget = trpc.cost.setBudget.useMutation()

  const summaryQ = trpc.cost.summary.useQuery(
    { projectId: activeProjectId ?? '' },
    { enabled: !!activeProjectId },
  )

  const handleSave = () => {
    if (!activeProjectId) return
    const cap = parseFloat(hardCap)
    const soft = parseInt(softPct, 10)
    if (isNaN(cap) || cap <= 0) return
    setBudget.mutate({
      scope: 'project',
      scopeId: activeProjectId,
      hardCapUsd: cap,
      softThresholdPct: isNaN(soft) ? 80 : soft,
      onSoft,
      onHard,
    })
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Budget defaults</h2>
        <p className="mt-1 text-sm text-slate-500">
          Configure cost caps for the active project. These caps are checked before each agent spawn
          and in real-time during LLM calls.
        </p>
      </div>

      {/* Current status */}
      {summaryQ.data && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-medium text-slate-700">Current project spend</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-500">Total: </span>
              <span className="font-mono font-medium text-slate-900">
                ${summaryQ.data.totalCostUsd.toFixed(4)}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Today: </span>
              <span className="font-mono font-medium text-slate-900">
                ${summaryQ.data.todayCostUsd.toFixed(4)}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Hard cap: </span>
              <span className="font-mono font-medium text-slate-900">
                {summaryQ.data.hardCapUsd != null
                  ? `$${summaryQ.data.hardCapUsd.toFixed(2)}`
                  : 'None configured'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Budget %: </span>
              <span className="font-mono font-medium text-slate-900">
                {Math.round(summaryQ.data.pctUsed * 100)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Form */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="budget-hard-cap" className="mb-1 block text-sm font-medium text-slate-700">
              Hard cap (USD)
            </label>
            <input
              id="budget-hard-cap"
              type="number"
              min="0.01"
              step="0.01"
              value={hardCap}
              onChange={(e) => setHardCap(e.target.value)}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-slate-400">Spawns are blocked when this is reached.</p>
          </div>
          <div>
            <label htmlFor="budget-soft-pct" className="mb-1 block text-sm font-medium text-slate-700">
              Soft threshold (%)
            </label>
            <input
              id="budget-soft-pct"
              type="number"
              min="1"
              max="100"
              step="1"
              value={softPct}
              onChange={(e) => setSoftPct(e.target.value)}
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-slate-400">Warning emitted at this percentage.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="budget-on-soft" className="mb-1 block text-sm font-medium text-slate-700">
              On soft threshold
            </label>
            <select
              id="budget-on-soft"
              value={onSoft}
              onChange={(e) => setOnSoft(e.target.value as typeof onSoft)}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="alert">Alert only</option>
              <option value="pause">Pause new spawns</option>
              <option value="none">No action</option>
            </select>
          </div>
          <div>
            <label htmlFor="budget-on-hard" className="mb-1 block text-sm font-medium text-slate-700">
              On hard cap
            </label>
            <select
              id="budget-on-hard"
              value={onHard}
              onChange={(e) => setOnHard(e.target.value as typeof onHard)}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="pause">Pause (block new spawns)</option>
              <option value="kill">Kill all workers immediately</option>
              <option value="alert_only">Alert only (no pause)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            disabled={setBudget.isPending || !activeProjectId}
            onClick={handleSave}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {setBudget.isPending ? 'Saving…' : 'Save budget'}
          </button>
          {!activeProjectId && (
            <p className="text-xs text-slate-400">Select a project to set its budget.</p>
          )}
          {setBudget.isSuccess && (
            <p className="text-xs text-emerald-600">Budget saved.</p>
          )}
          {setBudget.isError && (
            <p className="text-xs text-red-600">{setBudget.error.message}</p>
          )}
        </div>
      </div>

      {/* Info panel */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">How enforcement works</p>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
          <li>Before each agent spawn, the scheduler checks the running cost against this cap.</li>
          <li>After each LLM call, a cost ledger entry is written and the live cap is checked.</li>
          <li>
            If <code className="rounded bg-amber-100 px-1">on_hard = kill</code>, all workers in the
            scope receive SIGTERM when the cap is exceeded mid-run.
          </li>
          <li>Budgets are per-scope: install &gt; project &gt; sprint (most specific wins).</li>
        </ul>
      </div>
    </div>
  )
}
