/**
 * HealthPanel — live status of orchestrator subsystems.
 *
 * Polls admin.health.live every 5 seconds. Status pills:
 *   ok       → emerald
 *   degraded → amber
 *   down     → rose
 *
 * Also surfaces uptime and the install_id so operators can correlate
 * with audit logs.
 */

import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'

const REFRESH_MS = 5_000

function formatUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h}h ${mm}m`
}

function statusBadge(status: 'ok' | 'degraded' | 'down') {
  if (status === 'ok') return <Badge color="emerald">OK</Badge>
  if (status === 'degraded') return <Badge color="amber">Degraded</Badge>
  return <Badge color="rose">Down</Badge>
}

export function HealthPanel() {
  const live = trpc.admin.health.live.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  })
  const metrics = trpc.admin.metrics.snapshot.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  })

  if (live.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (live.isError) {
    return <ErrorMessage message={live.error.message ?? 'Could not load health'} />
  }

  const data = live.data
  if (!data) {
    return <ErrorMessage message="No health data returned" />
  }

  return (
    <div className="space-y-6">
      <section
        aria-label="Process info"
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Uptime</p>
            <p className="mt-1 font-mono text-lg text-slate-900">
              {formatUptime(data.uptimeSec)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Started at</p>
            <p className="mt-1 text-sm text-slate-900">
              {new Date(data.startedAt).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Install ID</p>
            <p className="mt-1 break-all font-mono text-xs text-slate-700">{data.installId}</p>
          </div>
        </div>
      </section>

      <section
        aria-label="Subsystems"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <header className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Subsystems</h3>
        </header>
        <ul className="divide-y divide-slate-100">
          {data.subsystems.map((s) => (
            <li key={s.name} className="flex items-center justify-between px-5 py-3">
              <div>
                <p className="text-sm font-medium text-slate-900">{s.name}</p>
                {s.detail && <p className="mt-0.5 text-xs text-slate-500">{s.detail}</p>}
              </div>
              {statusBadge(s.status)}
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-label="Metrics snapshot"
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <header className="mb-4">
          <h3 className="text-sm font-semibold text-slate-900">Metrics snapshot</h3>
          {metrics.data && (
            <p className="mt-0.5 text-xs text-slate-500">
              collected {new Date(metrics.data.collectedAt).toLocaleTimeString()}
            </p>
          )}
        </header>
        {metrics.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : metrics.isError ? (
          <ErrorMessage message={metrics.error.message ?? 'Could not load metrics'} />
        ) : metrics.data ? (
          <dl className="grid grid-cols-3 gap-x-8 gap-y-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Active workers</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">{metrics.data.activeWorkers}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Capability denials</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">
                {metrics.data.capabilityDenials}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Total events</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">{metrics.data.totalEvents}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Sprint cost</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">
                ${metrics.data.sprintCostUsd.toFixed(2)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Sprint budget</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">
                {metrics.data.sprintBudgetUsd === null
                  ? '—'
                  : `$${metrics.data.sprintBudgetUsd.toFixed(2)}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Exports completed</dt>
              <dd className="mt-1 font-mono text-lg text-slate-900">
                {metrics.data.exportsCompleted}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>
  )
}
