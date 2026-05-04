/**
 * BillingPage — /settings/billing real cost surface for the active project.
 *
 * Sections:
 *   1. Hero — month spend + sparkline + monthly cap progress
 *   2. Breakdown — pie/legend by billing category
 *   3. Top expensive stories — table linking to /stories/:id
 *   4. Budget caps & policy — monthly cap, hard-stop, digest emails
 *   5. Cost projection — velocity-based month-end forecast
 *   6. Export — CSV download for a date range
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Sparkline } from './Sparkline.js'
import { CategoryBreakdown } from './CategoryBreakdown.js'
import { TopExpensiveTable } from './TopExpensiveTable.js'
import { BudgetSettingsForm } from './BudgetSettingsForm.js'

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 4 : 2,
  })
}

function formatMonthLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function BillingPage() {
  const projectId = useActiveProjectStore((s) => s.activeProjectId)

  if (!projectId) {
    return (
      <div className="rounded-card-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
        Select a project to view its billing surface.
      </div>
    )
  }

  return <BillingPageInner projectId={projectId} />
}

function BillingPageInner({ projectId }: { projectId: string }) {
  const summaryQ = trpc.billing.summary.useQuery({ projectId }, { refetchInterval: 30_000 })
  const seriesQ = trpc.billing.dailySeries.useQuery({ projectId }, { refetchInterval: 30_000 })
  const byCatQ = trpc.billing.byCategory.useQuery({ projectId }, { refetchInterval: 60_000 })
  const topQ = trpc.billing.topExpensive.useQuery({ projectId, limit: 10 }, { refetchInterval: 60_000 })
  const projectionQ = trpc.billing.projection.useQuery({ projectId }, { refetchInterval: 60_000 })

  const refreshAll = () => {
    summaryQ.refetch()
    seriesQ.refetch()
    byCatQ.refetch()
    topQ.refetch()
    projectionQ.refetch()
  }

  const summary = summaryQ.data
  const isEmpty = summary != null && summary.entryCount === 0 && summary.totalCostUsd === 0

  return (
    <div className="space-y-6">
      {/* ---- Hero ---- */}
      <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
          <div>
            <p className="text-eyebrow font-semibold uppercase text-slate-500">
              {summary ? formatMonthLabel(summary.monthStart) : 'This month'}
            </p>
            <p className="mt-1 text-display-lg tabular-nums text-slate-900">
              {summary ? formatUsd(summary.monthCostUsd) : '—'}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {isEmpty
                ? '$0.00 — no agent runs yet for this project.'
                : summary
                  ? `${summary.entryCount.toLocaleString()} LLM calls this month · ${formatUsd(summary.totalCostUsd)} all-time`
                  : 'Loading…'}
            </p>

            {summary?.monthlyCapUsd != null && summary.monthlyCapUsd > 0 && (
              <div className="mt-4 max-w-md">
                <div className="flex items-baseline justify-between text-xs text-slate-500">
                  <span>vs cap {formatUsd(summary.monthlyCapUsd)}</span>
                  <span
                    className={`font-mono ${
                      summary.pctUsed >= 1
                        ? 'text-red-600'
                        : summary.pctUsed >= 0.8
                          ? 'text-amber-600'
                          : 'text-slate-500'
                    }`}
                  >
                    {Math.round(summary.pctUsed * 100)}%
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      summary.pctUsed >= 1
                        ? 'bg-red-500'
                        : summary.pctUsed >= 0.8
                          ? 'bg-amber-500'
                          : 'bg-brand-500'
                    }`}
                    style={{ width: `${Math.min(100, summary.pctUsed * 100)}%` }}
                    aria-label={`${Math.round(summary.pctUsed * 100)}% of monthly cap used`}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="md:border-l md:border-slate-100 md:pl-6">
            <p className="mb-1 text-eyebrow font-semibold uppercase text-slate-500">Daily spend</p>
            <Sparkline points={seriesQ.data?.series ?? []} />
            <p className="mt-1 text-xs text-slate-400">
              {seriesQ.data?.series.length ?? 0} day{(seriesQ.data?.series.length ?? 0) === 1 ? '' : 's'} this month
            </p>
          </div>
        </div>
      </section>

      {/* ---- Breakdown + Top expensive ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
          <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">Spend by category</h3>
          <CategoryBreakdown rows={byCatQ.data?.totals ?? []} />
        </section>

        <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
          <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">
            Top expensive stories
          </h3>
          <TopExpensiveTable rows={topQ.data?.rows ?? []} />
        </section>
      </div>

      {/* ---- Projection ---- */}
      <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
        <h3 className="mb-3 text-eyebrow font-semibold uppercase text-slate-500">Projection</h3>
        {projectionQ.data ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={`Avg / day (last ${projectionQ.data.windowDays}d)`} value={formatUsd(projectionQ.data.avgDailyUsd)} />
            <Stat label="Days remaining this month" value={String(projectionQ.data.daysRemaining)} />
            <Stat
              label="Forecasted month spend"
              value={formatUsd(projectionQ.data.forecastedMonthSpendUsd)}
              hint={summary?.monthlyCapUsd != null
                ? projectionQ.data.forecastedMonthSpendUsd > summary.monthlyCapUsd
                  ? 'Projected to exceed monthly cap'
                  : 'Within cap'
                : undefined}
              danger={summary?.monthlyCapUsd != null && projectionQ.data.forecastedMonthSpendUsd > summary.monthlyCapUsd}
            />
          </div>
        ) : (
          <p className="text-sm text-slate-400">Loading projection…</p>
        )}
      </section>

      {/* ---- Budget settings + Export ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
          <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">Budget caps & alerts</h3>
          {summary ? (
            <BudgetSettingsForm
              projectId={projectId}
              monthlyCapUsd={summary.monthlyCapUsd}
              hardStop={summary.hardStop}
              digestEmails={summary.digestEmails}
              onUpdated={refreshAll}
            />
          ) : (
            <p className="text-sm text-slate-400">Loading…</p>
          )}
          <div className="mt-4 rounded-md border border-slate-100 bg-slate-50 p-3 text-xs text-slate-500">
            Per-sprint and per-week caps are configured under{' '}
            <a className="text-brand-700 underline-offset-2 hover:underline" href="/settings/sprints">
              Sprints → Budget
            </a>
            .
          </div>
        </section>

        <ExportCard projectId={projectId} />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  danger = false,
}: {
  label: string
  value: string
  hint?: string
  danger?: boolean
}) {
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${danger ? 'text-red-600' : 'text-slate-900'}`}>
        {value}
      </p>
      {hint && <p className={`mt-1 text-xs ${danger ? 'text-red-600' : 'text-slate-400'}`}>{hint}</p>}
    </div>
  )
}

function ExportCard({ projectId }: { projectId: string }) {
  const today = new Date()
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const tomorrow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))

  const [fromDate, setFromDate] = useState<string>(monthStart.toISOString().slice(0, 10))
  const [toDate, setToDate] = useState<string>(tomorrow.toISOString().slice(0, 10))
  const [lastResult, setLastResult] = useState<{ rowCount: number; truncated: boolean } | null>(null)

  const exportMutation = trpc.billing.exportCsv.useMutation()

  const handleExport = async () => {
    const fromIso = new Date(`${fromDate}T00:00:00.000Z`).toISOString()
    const toIso = new Date(`${toDate}T00:00:00.000Z`).toISOString()
    const result = await exportMutation.mutateAsync({ projectId, fromDate: fromIso, toDate: toIso })
    setLastResult({ rowCount: result.rowCount, truncated: result.truncated })

    // Decode base64 → Blob → download
    const binary = atob(result.csvBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <section className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card md:p-6">
      <h3 className="mb-4 text-eyebrow font-semibold uppercase text-slate-500">Export</h3>
      <p className="mb-4 text-sm text-slate-600">
        Download every cost-ledger row in a date range as CSV. Includes per-call tokens, model, persona,
        derived category, and USD cost.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="billing-export-from" className="mb-1 block text-xs font-medium text-slate-600">
            From
          </label>
          <input
            id="billing-export-from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label htmlFor="billing-export-to" className="mb-1 block text-xs font-medium text-slate-600">
            To (exclusive)
          </label>
          <input
            id="billing-export-to"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={exportMutation.isPending || !fromDate || !toDate}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exportMutation.isPending ? 'Generating…' : 'Download CSV'}
        </button>
        {lastResult && (
          <span className="text-xs text-slate-500">
            Exported {lastResult.rowCount.toLocaleString()} row{lastResult.rowCount === 1 ? '' : 's'}
            {lastResult.truncated && ' (truncated at 50,000)'}
          </span>
        )}
        {exportMutation.isError && (
          <span className="text-xs text-red-600">{exportMutation.error.message}</span>
        )}
      </div>
    </section>
  )
}
