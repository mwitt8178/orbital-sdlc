/**
 * SprintPlanSummary — pre-launch cost forecast vs cap card.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Shows the forecasted cost vs configured budget cap before a sprint is
 * launched. Blocks the "Launch sprint" CTA when forecast already exceeds cap.
 *
 * Usage: render alongside the sprint planning modal / backlog view.
 */

import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'

interface SprintPlanSummaryProps {
  sprintId: string
  sprintName: string
  /** Estimated total cost for this sprint (from task estimates or 0). */
  forecastedCostUsd: number
  onLaunch?: () => void
  launchDisabledReason?: string
}

export function SprintPlanSummary({
  sprintId,
  sprintName,
  forecastedCostUsd,
  onLaunch,
  launchDisabledReason,
}: SprintPlanSummaryProps) {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  const summaryQ = trpc.cost.summary.useQuery(
    { projectId: activeProjectId ?? '', sprintId },
    { enabled: !!activeProjectId },
  )

  const summary = summaryQ.data
  const hardCapUsd = summary?.hardCapUsd ?? null
  const spentUsd = summary?.totalCostUsd ?? 0

  const projectedTotal = spentUsd + forecastedCostUsd
  const exceedsCap = hardCapUsd != null && projectedTotal > hardCapUsd
  const approachingCap = hardCapUsd != null && projectedTotal > hardCapUsd * 0.8 && !exceedsCap

  const pct = hardCapUsd ? Math.min(1, projectedTotal / hardCapUsd) : 0

  const barColor = exceedsCap
    ? 'bg-red-500'
    : approachingCap
      ? 'bg-amber-500'
      : 'bg-emerald-500'

  const launchBlocked = !!launchDisabledReason || exceedsCap
  const launchReason = exceedsCap
    ? `Forecasted cost $${projectedTotal.toFixed(2)} exceeds hard cap $${hardCapUsd?.toFixed(2)}`
    : launchDisabledReason

  return (
    <div
      className={clsx(
        'rounded-lg border p-4',
        exceedsCap
          ? 'border-red-200 bg-red-50'
          : approachingCap
            ? 'border-amber-200 bg-amber-50'
            : 'border-slate-200 bg-white',
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">{sprintName}</p>
          <p className="mt-0.5 text-xs text-slate-500">Cost forecast</p>
        </div>
        {exceedsCap && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
            Over cap
          </span>
        )}
        {approachingCap && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
            Near cap
          </span>
        )}
      </div>

      <div className="mb-3 space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">Already spent</span>
          <span className="font-mono text-slate-700">${spentUsd.toFixed(4)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Forecast (new tasks)</span>
          <span className="font-mono text-slate-700">${forecastedCostUsd.toFixed(4)}</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span className="text-slate-700">Projected total</span>
          <span className={clsx('font-mono', exceedsCap ? 'text-red-700' : 'text-slate-900')}>
            ${projectedTotal.toFixed(4)}
          </span>
        </div>
        {hardCapUsd != null && (
          <div className="flex justify-between">
            <span className="text-slate-500">Hard cap</span>
            <span className="font-mono text-slate-700">${hardCapUsd.toFixed(2)}</span>
          </div>
        )}
      </div>

      {hardCapUsd != null && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
      )}

      {onLaunch && (
        <button
          type="button"
          disabled={launchBlocked}
          onClick={onLaunch}
          title={launchReason}
          className={clsx(
            'w-full rounded-md px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            launchBlocked
              ? 'cursor-not-allowed bg-slate-100 text-slate-400'
              : 'bg-brand-600 text-white hover:bg-brand-700',
          )}
        >
          {exceedsCap ? 'Cannot launch — over cap' : 'Launch sprint'}
        </button>
      )}

      {launchReason && (
        <p className="mt-2 text-xs text-red-600">{launchReason}</p>
      )}
    </div>
  )
}
