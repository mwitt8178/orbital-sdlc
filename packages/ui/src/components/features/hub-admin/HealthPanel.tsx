/**
 * hub-admin/HealthPanel.tsx — Hub health status panel.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Polls GET /admin/health every 5s. Renders:
 *   - Mode, version, uptime
 *   - DB status pill
 *   - Tenant count
 */

import { useEffect, useState, useCallback } from 'react'
import { Badge } from '../../ui/Badge.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

const REFRESH_MS = 5_000

interface HubHealth {
  mode: string
  version: string
  uptime: number
  timestamp: string
  db: { status: 'ok' | 'down'; detail?: string }
  tenantCount: number
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h}h ${mm}m`
}

function DbStatusBadge({ status }: { status: 'ok' | 'down' }) {
  return status === 'ok' ? <Badge color="emerald">OK</Badge> : <Badge color="rose">Down</Badge>
}

export function HubHealthPanel() {
  const [data, setData] = useState<HubHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/admin/health')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: HubHealth = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError((err as Error).message ?? 'Could not load hub health')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetch_()
    const interval = setInterval(() => void fetch_(), REFRESH_MS)
    return () => clearInterval(interval)
  }, [fetch_])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error) {
    return <ErrorMessage message={error} />
  }

  if (!data) {
    return <ErrorMessage message="No hub health data returned" />
  }

  return (
    <div className="space-y-6">
      <section
        aria-label="Hub overview"
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h3 className="mb-4 text-sm font-semibold text-slate-900">Hub overview</h3>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Mode</p>
            <p className="mt-1 font-mono text-sm font-semibold text-brand-700">{data.mode}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Version</p>
            <p className="mt-1 font-mono text-sm text-slate-900">{data.version}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Uptime</p>
            <p className="mt-1 font-mono text-lg text-slate-900">{formatUptime(data.uptime)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Tenant count</p>
            <p className="mt-1 font-mono text-lg text-slate-900">{data.tenantCount}</p>
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
          <li className="flex items-center justify-between px-5 py-3">
            <div>
              <p className="text-sm font-medium text-slate-900">Database (Postgres)</p>
              {data.db.detail && (
                <p className="mt-0.5 text-xs text-slate-500">{data.db.detail}</p>
              )}
            </div>
            <DbStatusBadge status={data.db.status} />
          </li>
        </ul>
      </section>

      <p className="text-right text-xs text-slate-400">
        Last refreshed: {new Date(data.timestamp).toLocaleTimeString()}
      </p>
    </div>
  )
}
