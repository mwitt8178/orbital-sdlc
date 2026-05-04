/**
 * Cost — cost governance overview page.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Sections:
 *   - Top stats: today / sprint / project spend vs cap
 *   - Live burn chart (last 1h / 24h / 7d)
 *   - Per-task cost ledger table
 *   - Budget panels (install / project / sprint)
 *   - Kill switch panel
 */

import { useState, useEffect, useRef } from 'react'
import { trpc } from '../services/trpc.js'
import { buildPublicWsUrl } from '../services/ws.js'
import { useActiveProjectStore } from '../store/active-project.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'
import { LiveBurnChart } from '../components/features/cost/LiveBurnChart.js'
import { BudgetCard } from '../components/features/cost/BudgetCard.js'
import { CostLedgerTable } from '../components/features/cost/CostLedgerTable.js'
import { KillAllModal } from '../components/features/cost/KillAllModal.js'
import type { CostLedgerAppendedPayload } from '../types/events.js'

type TimeWindow = '1h' | '24h' | '7d'

const WINDOW_MS: Record<TimeWindow, number> = {
  '1h':  60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d':  7  * 24 * 60 * 60 * 1_000,
}

interface BurnPoint {
  ts: number
  costUsd: number
}

function useWsLedgerEvents(projectId: string | null, onEntry: (p: CostLedgerAppendedPayload) => void) {
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!projectId) return
    // Mirror services/ws.ts URL resolution. When VITE_WS_URL is unset and we're
    // not running on an origin that can serve same-origin /ws, skip the
    // connection so we don't error-loop in CloudFront-only builds.
    const url = buildPublicWsUrl()
    if (!url) return
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type?: string; payload?: unknown }
        if (msg.type === 'CostLedgerAppended') {
          onEntry(msg.payload as CostLedgerAppendedPayload)
        }
      } catch {
        // malformed frame — ignore
      }
    }

    return () => {
      ws.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
}

export default function Cost() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)
  const [window_, setWindow] = useState<TimeWindow>('24h')
  const [showKill, setShowKill] = useState(false)
  const [burnPoints, setBurnPoints] = useState<BurnPoint[]>([])

  const projectId = activeProjectId ?? ''

  const summaryQ = trpc.cost.summary.useQuery(
    { projectId },
    { enabled: !!projectId, refetchInterval: 15_000 },
  )

  // Accumulate live burn points from WS events
  useWsLedgerEvents(projectId || null, (p) => {
    const ts = Date.now()
    setBurnPoints((prev) => {
      const next = [...prev, { ts, costUsd: (prev[prev.length - 1]?.costUsd ?? 0) + p.cost_usd }]
      // Keep only within window
      const cutoff = ts - WINDOW_MS[window_]
      return next.filter((pt) => pt.ts >= cutoff)
    })
  })

  const summary = summaryQ.data

  if (!projectId) {
    return (
      <div className="mx-auto max-w-[1400px] px-8 py-6">
        <p className="text-slate-500">Select a project to view cost data.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <span>Cost</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Cost Governance</h1>
        <p className="mt-1 text-sm text-slate-500">
          Live cost burn, per-task ledger, and budget management.
        </p>
      </header>

      {/* Stats row */}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Today"
            value={`$${summary.todayCostUsd.toFixed(4)}`}
            sub={summary.hardCapUsd != null ? `/ $${summary.hardCapUsd.toFixed(2)} cap` : 'No cap'}
          />
          <StatCard
            label="Total (scope)"
            value={`$${summary.totalCostUsd.toFixed(4)}`}
            sub={`${Math.round(summary.pctUsed * 100)}% of cap`}
          />
          <StatCard
            label="Entries"
            value={String(summary.entryCount)}
            sub="LLM calls logged"
          />
          <StatCard
            label="Budget status"
            value={summary.pctUsed >= 1 ? 'OVER CAP' : summary.pctUsed >= 0.8 ? 'WARNING' : 'OK'}
            sub={summary.hardCapUsd != null ? `Hard cap $${summary.hardCapUsd.toFixed(2)}` : 'Uncapped'}
            danger={summary.pctUsed >= 1}
            warn={summary.pctUsed >= 0.8 && summary.pctUsed < 1}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left 2/3: chart + ledger */}
        <div className="space-y-6 lg:col-span-2">
          {/* Burn chart */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Live burn</h2>
              <div className="flex gap-1">
                {(['1h', '24h', '7d'] as TimeWindow[]).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWindow(w)}
                    className={`rounded px-2 py-1 text-xs font-medium transition ${
                      window_ === w
                        ? 'bg-brand-100 text-brand-700'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
            <LiveBurnChart
              points={burnPoints}
              hardCapUsd={summary?.hardCapUsd ?? null}
              label={window_}
            />
          </div>

          {/* Ledger table */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Per-call ledger</h2>
            <CostLedgerTable projectId={projectId} />
          </div>
        </div>

        {/* Right 1/3: budget + kill */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Budget configuration</h2>

          <BudgetCard
            scope="project"
            scopeId={projectId}
            label={`Project ${projectId.slice(0, 8)}…`}
            runningCostUsd={summary?.totalCostUsd ?? 0}
            hardCapUsd={summary?.hardCapUsd ?? null}
            softThresholdPct={summary?.softThresholdPct ?? 80}
            onSoft="alert"
            onHard="pause"
            canEdit
            onUpdated={() => summaryQ.refetch()}
          />

          {/* Kill switch panel */}
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-red-900">Hard kill switch</h3>
            <p className="mb-3 text-xs text-red-700">
              SIGTERM all active workers in this project scope immediately.
              Use only in emergencies or when budget is critically exceeded.
            </p>
            <button
              type="button"
              onClick={() => setShowKill(true)}
              className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              Kill all workers
            </button>
          </div>
        </div>
      </div>

      {showKill && (
        <KillAllModal
          scope="project"
          scopeId={projectId}
          scopeLabel={`Project ${projectId.slice(0, 8)}…`}
          onClose={() => setShowKill(false)}
          onKilled={() => summaryQ.refetch()}
        />
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  danger = false,
  warn = false,
}: {
  label: string
  value: string
  sub: string
  danger?: boolean
  warn?: boolean
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-1 text-xl font-bold ${
          danger ? 'text-red-600' : warn ? 'text-amber-600' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
    </div>
  )
}
