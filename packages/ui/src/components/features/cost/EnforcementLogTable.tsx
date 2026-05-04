/**
 * EnforcementLogTable — shows recent allow/block/throttle decisions from cost_enforcement_log.
 *
 * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
 *
 * Used on the Billing settings page to give operators visibility into why
 * a run was blocked by the monthly budget cap.
 */

import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Link } from 'react-router-dom'

const DECISION_COLORS: Record<string, string> = {
  allow:    'bg-emerald-100 text-emerald-800',
  block:    'bg-red-100 text-red-800',
  throttle: 'bg-amber-100 text-amber-800',
}

function fmtUsd(n: number | null): string {
  if (n == null) return '—'
  return `$${n.toFixed(4)}`
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function EnforcementLogTable() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  const logQ = trpc.cost.enforcementLog.useQuery(
    { projectId: activeProjectId ?? '', limit: 50 },
    { enabled: !!activeProjectId },
  )

  if (!activeProjectId) {
    return (
      <p className="text-sm text-slate-500">Select a project to see enforcement history.</p>
    )
  }

  if (logQ.isLoading) {
    return <p className="text-sm text-slate-400">Loading enforcement log…</p>
  }

  if (logQ.isError) {
    return (
      <p className="text-sm text-red-600">
        Failed to load enforcement log: {logQ.error.message}
      </p>
    )
  }

  const rows = logQ.data?.rows ?? []

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No enforcement decisions recorded yet. Decisions appear once agent runs are checked
        against the budget cap.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="pb-2 pr-4 font-medium">Time</th>
            <th className="pb-2 pr-4 font-medium">Decision</th>
            <th className="pb-2 pr-4 font-medium">Persona</th>
            <th className="pb-2 pr-4 font-medium">MTD Spend</th>
            <th className="pb-2 pr-4 font-medium">Estimate</th>
            <th className="pb-2 pr-4 font-medium">Cap</th>
            <th className="pb-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id} className="py-1">
              <td className="py-1.5 pr-4 text-slate-500">{fmtTime(row.createdAt)}</td>
              <td className="py-1.5 pr-4">
                <span
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${DECISION_COLORS[row.decision] ?? 'bg-slate-100 text-slate-700'}`}
                >
                  {row.decision}
                </span>
              </td>
              <td className="py-1.5 pr-4 font-mono text-slate-700">{row.persona ?? '—'}</td>
              <td className="py-1.5 pr-4 font-mono">{fmtUsd(row.mtdSpendUsd)}</td>
              <td className="py-1.5 pr-4 font-mono">{fmtUsd(row.wouldBeCostEstimateUsd)}</td>
              <td className="py-1.5 pr-4 font-mono">{fmtUsd(row.budgetCapUsd)}</td>
              <td className="py-1.5 max-w-xs truncate text-slate-500" title={row.reason ?? undefined}>
                {row.reason ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {logQ.data?.nextCursor && (
        <p className="mt-2 text-xs text-slate-400">
          Showing 50 most recent decisions.{' '}
          <Link to="/cost" className="text-brand-700 hover:underline">
            See full cost page
          </Link>{' '}
          for full history.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BudgetBlockedBanner — inline warning for story run UIs
// ---------------------------------------------------------------------------

interface BudgetBlockedBannerProps {
  reason?: string
}

/**
 * Surfaces "Blocked: monthly budget exceeded" on a story run UI.
 * Include this component when a story run returns reason='budget_exceeded'.
 */
export function BudgetBlockedBanner({ reason }: BudgetBlockedBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4"
    >
      <svg
        aria-hidden="true"
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 flex-none text-red-500"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div>
        <p className="text-sm font-semibold text-red-800">Blocked: monthly budget exceeded</p>
        {reason && (
          <p className="mt-0.5 text-xs text-red-700">{reason}</p>
        )}
        <p className="mt-1 text-xs text-red-600">
          <Link
            to="/settings/billing"
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Review your budget in Settings / Billing
          </Link>{' '}
          to increase the cap or wait until next month.
        </p>
      </div>
    </div>
  )
}
