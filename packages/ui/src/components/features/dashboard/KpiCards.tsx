/**
 * KpiCards — sprint-level KPI summary.
 *
 * Real aggregation rules:
 *   - Avg cycle time: average of `completedAt - startedAt` over tasks that
 *     have both timestamps in the supplied tasks array (most recent 50
 *     done tasks). Rendered as a human duration ("2h 14m"). When no
 *     completed task has both timestamps, show "—" with a "no completed
 *     tasks yet" sub-line.
 *   - Verifier pass rate: percentage of `VerifierPassed` events over
 *     (passed + failed) within the events window (the events store keeps
 *     the last ~200 envelopes; the dashboard refresh keeps this in sync).
 *   - Escalations: count of `EscalationRaised` events.
 *   - Capability denials: count of `CapabilityDenied` events.
 *
 * Where data is not available, render an em-dash placeholder with a
 * "no data yet" sub-label rather than fabricating numbers.
 */

import { useMemo } from 'react'
import type { EventEnvelope } from '@orbital/types'

interface TaskLike {
  taskId?: string
  task_id?: string
  state?: string
  startedAt?: Date | string | null
  started_at?: Date | string | null
  completedAt?: Date | string | null
  completed_at?: Date | string | null
}

interface KpiCardsProps {
  events: EventEnvelope[]
  tasks?: TaskLike[]
}

interface Kpi {
  label: string
  value: string
  sub: string
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : t
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}

function computeKpis(events: EventEnvelope[], tasks: TaskLike[]): Kpi[] {
  const noData = events.length === 0 && tasks.length === 0

  // Avg cycle time — done tasks only, last 50.
  const cycleSamples: number[] = []
  if (tasks.length > 0) {
    const done = tasks
      .filter((t) => (t.state ?? '') === 'done')
      .slice(0, 50)
    for (const t of done) {
      const start = toMs(t.startedAt ?? t.started_at)
      const end = toMs(t.completedAt ?? t.completed_at)
      if (start !== null && end !== null && end >= start) {
        cycleSamples.push(end - start)
      }
    }
  }
  const avgCycleMs =
    cycleSamples.length > 0
      ? cycleSamples.reduce((a, b) => a + b, 0) / cycleSamples.length
      : null

  // Verifier pass rate — over the events window. (The events store buffers
  // ~200 entries; ~7-day windowing happens server-side in the audit
  // archive. For the dashboard buffer this is "recent activity", which is
  // the intended UX: the card reflects the present rate.)
  const verifierPassed = events.filter((e) => e.event_type === 'VerifierPassed').length
  const verifierFailed = events.filter((e) => e.event_type === 'VerifierFailed').length
  const verifierTotal = verifierPassed + verifierFailed
  const passRate = verifierTotal > 0 ? Math.round((verifierPassed / verifierTotal) * 100) : null

  // Escalations + capability denials in the current event buffer.
  const escalations = events.filter((e) => e.event_type === 'EscalationRaised').length
  const denials = events.filter((e) => e.event_type === 'CapabilityDenied').length

  if (noData) {
    return [
      { label: 'Avg cycle time', value: '—', sub: 'No sprint data yet' },
      { label: 'Verifier pass rate', value: '—', sub: 'No sprint data yet' },
      { label: 'Escalations', value: '—', sub: 'No sprint data yet' },
      { label: 'Capability denials', value: '—', sub: 'No sprint data yet' },
    ]
  }

  return [
    {
      label: 'Avg cycle time',
      value: avgCycleMs !== null ? formatDuration(avgCycleMs) : '—',
      sub:
        avgCycleMs !== null
          ? `${cycleSamples.length} done task${cycleSamples.length === 1 ? '' : 's'}`
          : 'No completed tasks yet',
    },
    {
      label: 'Verifier pass rate',
      value: passRate !== null ? `${passRate}%` : '—',
      sub: passRate !== null ? `${verifierTotal} runs` : 'No verifier runs yet',
    },
    {
      label: 'Escalations',
      value: escalations.toString(),
      sub: escalations === 0 ? 'No escalations' : 'Open escalations may need attention',
    },
    {
      label: 'Capability denials',
      value: denials.toString(),
      sub: denials === 0 ? 'No denials' : 'Review denied capability requests',
    },
  ]
}

export function KpiCards({ events, tasks = [] }: KpiCardsProps) {
  const kpis = useMemo(() => computeKpis(events, tasks), [events, tasks])
  return (
    <div className="mb-6 grid grid-cols-4 gap-4" role="list">
      {kpis.map((kpi) => (
        <div
          key={kpi.label}
          role="listitem"
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <div className="mb-1 text-xs text-slate-500">{kpi.label}</div>
          <div className="text-2xl font-bold text-slate-900">{kpi.value}</div>
          <div className="mt-1 text-xs text-slate-400">{kpi.sub}</div>
        </div>
      ))}
    </div>
  )
}
