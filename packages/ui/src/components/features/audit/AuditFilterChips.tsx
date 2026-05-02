/**
 * AuditFilterChips — chip-style filters for the audit timeline.
 *
 * - Aggregate type: multi-select chips (task, sprint, capability, channel, …)
 * - Date range: today / 7d / 30d / custom
 * - Actor type: persona / user / system / hook
 *
 * Filters are reported via a single onChange callback so the parent can
 * compose them into the `audit.events.query` payload.
 */

import { useMemo } from 'react'

export type ActorType = 'persona' | 'user' | 'system' | 'hook'
export type DateRangePreset = 'all' | 'today' | '7d' | '30d' | 'custom'

export interface AuditFilters {
  aggregateTypes: string[]
  actorTypes: ActorType[]
  rangePreset: DateRangePreset
  occurredAfter?: string
  occurredBefore?: string
}

interface Props {
  filters: AuditFilters
  onChange: (filters: AuditFilters) => void
}

const AGGREGATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'task', label: 'task' },
  { value: 'sprint', label: 'sprint' },
  { value: 'capability', label: 'capability' },
  { value: 'channel', label: 'channel' },
  { value: 'channel_post', label: 'channel_post' },
  { value: 'ceremony', label: 'ceremony' },
  { value: 'persona', label: 'persona' },
  { value: 'audit_export', label: 'audit_export' },
  { value: 'system_version', label: 'system_version' },
  { value: 'install', label: 'install' },
  { value: 'verification', label: 'verification' },
]

const ACTOR_OPTIONS: Array<{ value: ActorType; label: string }> = [
  { value: 'persona', label: 'Persona' },
  { value: 'user', label: 'User' },
  { value: 'system', label: 'System' },
  { value: 'hook', label: 'Hook' },
]

const RANGE_OPTIONS: Array<{ value: DateRangePreset; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
  { value: 'custom', label: 'Custom' },
]

function rangeToIso(preset: DateRangePreset): {
  occurredAfter?: string
  occurredBefore?: string
} {
  if (preset === 'all') return {}
  const now = new Date()
  const end = new Date(now)
  end.setUTCHours(23, 59, 59, 999)
  if (preset === 'today') {
    const start = new Date(now)
    start.setUTCHours(0, 0, 0, 0)
    return { occurredAfter: start.toISOString(), occurredBefore: end.toISOString() }
  }
  if (preset === '7d') {
    const start = new Date(now)
    start.setUTCDate(start.getUTCDate() - 7)
    start.setUTCHours(0, 0, 0, 0)
    return { occurredAfter: start.toISOString(), occurredBefore: end.toISOString() }
  }
  if (preset === '30d') {
    const start = new Date(now)
    start.setUTCDate(start.getUTCDate() - 30)
    start.setUTCHours(0, 0, 0, 0)
    return { occurredAfter: start.toISOString(), occurredBefore: end.toISOString() }
  }
  return {}
}

export function AuditFilterChips({ filters, onChange }: Props) {
  const activeChipCount = useMemo(
    () =>
      filters.aggregateTypes.length +
      filters.actorTypes.length +
      (filters.rangePreset !== 'all' ? 1 : 0),
    [filters],
  )

  const toggleAggregate = (value: string) => {
    const next = new Set(filters.aggregateTypes)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange({ ...filters, aggregateTypes: Array.from(next) })
  }

  const toggleActor = (value: ActorType) => {
    const next = new Set(filters.actorTypes)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange({ ...filters, actorTypes: Array.from(next) })
  }

  const setRange = (preset: DateRangePreset) => {
    if (preset === 'custom') {
      onChange({ ...filters, rangePreset: preset })
      return
    }
    const { occurredAfter, occurredBefore } = rangeToIso(preset)
    onChange({
      ...filters,
      rangePreset: preset,
      ...(occurredAfter !== undefined ? { occurredAfter } : { occurredAfter: undefined }),
      ...(occurredBefore !== undefined ? { occurredBefore } : { occurredBefore: undefined }),
    })
  }

  const clearAll = () => {
    onChange({
      aggregateTypes: [],
      actorTypes: [],
      rangePreset: 'all',
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Aggregate type
        </p>
        <div className="flex flex-wrap gap-1.5">
          {AGGREGATE_OPTIONS.map((opt) => {
            const active = filters.aggregateTypes.includes(opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleAggregate(opt.value)}
                aria-pressed={active}
                className={
                  active
                    ? 'rounded-full border border-brand-300 bg-brand-50 px-2.5 py-0.5 font-mono text-[11px] text-brand-700'
                    : 'rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-slate-600 hover:bg-slate-50'
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Date range
          </p>
          <div className="flex flex-wrap gap-1.5">
            {RANGE_OPTIONS.map((opt) => {
              const active = filters.rangePreset === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRange(opt.value)}
                  aria-pressed={active}
                  className={
                    active
                      ? 'rounded-full border border-brand-300 bg-brand-50 px-2.5 py-0.5 text-[11px] text-brand-700'
                      : 'rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50'
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Actor type
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ACTOR_OPTIONS.map((opt) => {
              const active = filters.actorTypes.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleActor(opt.value)}
                  aria-pressed={active}
                  className={
                    active
                      ? 'rounded-full border border-brand-300 bg-brand-50 px-2.5 py-0.5 text-[11px] text-brand-700'
                      : 'rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50'
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {activeChipCount > 0 ? (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
          >
            Clear filters ({activeChipCount})
          </button>
        ) : null}
      </div>

      {filters.rangePreset === 'custom' ? (
        <div className="flex flex-wrap gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <label className="text-[11px] font-medium text-slate-600">
            Start
            <input
              type="datetime-local"
              value={filters.occurredAfter ? toLocalInput(filters.occurredAfter) : ''}
              onChange={(e) =>
                onChange({
                  ...filters,
                  occurredAfter: e.target.value ? fromLocalInput(e.target.value) : undefined,
                })
              }
              className="ml-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-600">
            End
            <input
              type="datetime-local"
              value={filters.occurredBefore ? toLocalInput(filters.occurredBefore) : ''}
              onChange={(e) =>
                onChange({
                  ...filters,
                  occurredBefore: e.target.value ? fromLocalInput(e.target.value) : undefined,
                })
              }
              className="ml-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs"
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}
