/**
 * Stories — reviewer queue page.
 *
 * [Engineer-Principal · Opus · run-orbital-review-ui]
 *
 * Lists stories awaiting review (default filter: status=in_review). Reviewer
 * can filter by status, project, owner, and cost band; navigate the list with
 * j/k like a mail client; click into a story for detail + actions.
 *
 * Cost dashboard widget at the top shows today / week / top-3 spenders so the
 * reviewer always has budget context before clicking Accept.
 *
 * Live updates: subscribes to `story:*` is too broad — instead this page
 * invalidates the list query whenever the events ring receives a story-touching
 * event (status changes, channel posts with payload.story_id present).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { trpc } from '../services/trpc.js'
import { useEventsStore } from '../store/events.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'
import { Badge } from '../components/ui/Badge.js'

type StoryStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'accepted'
  | 'blocked'
  | 'defective'
  | 'cancelled'

const STATUS_OPTIONS: StoryStatus[] = [
  'in_review',
  'ready',
  'in_progress',
  'done',
  'cancelled',
  'blocked',
]

interface CostBand {
  label: string
  min?: number
  max?: number
}

const COST_BANDS: CostBand[] = [
  { label: 'Any cost' },
  { label: '< $1', max: 1 },
  { label: '$1–$10', min: 1, max: 10 },
  { label: '$10–$50', min: 10, max: 50 },
  { label: '> $50', min: 50 },
]

function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

export default function Stories() {
  const navigate = useNavigate()
  const utils = trpc.useUtils()

  const [status, setStatus] = useState<StoryStatus>('in_review')
  const [costBandIdx, setCostBandIdx] = useState(0)
  const [cursorIdx, setCursorIdx] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  const band = COST_BANDS[costBandIdx]
  const listQuery = trpc.stories.list.useQuery({
    status,
    costMin: band?.min,
    costMax: band?.max,
    limit: 100,
  })
  const costQuery = trpc.stories.costSummary.useQuery(undefined, {
    refetchInterval: 60_000,
  })

  // Live updates: invalidate list when a story-touching event lands.
  const events = useEventsStore((s) => s.events)
  const lastSeenId = useRef<string | null>(null)
  useEffect(() => {
    if (events.length === 0) return
    const head = events[events.length - 1]
    if (!head || head.event_id === lastSeenId.current) return
    lastSeenId.current = head.event_id
    const p = (head.payload ?? {}) as Record<string, unknown>
    const touchesStory =
      head.aggregate_type === 'story' ||
      typeof p['story_id'] === 'string' ||
      head.event_type.startsWith('Story')
    if (touchesStory) {
      utils.stories.list.invalidate()
      utils.stories.costSummary.invalidate()
    }
  }, [events, utils])

  const stories = useMemo(() => listQuery.data?.stories ?? [], [listQuery.data])

  // j/k keyboard nav (mail-client style). Enter opens.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in inputs/selects
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'j') {
        e.preventDefault()
        setCursorIdx((i) => Math.min(stories.length - 1, i + 1))
      } else if (e.key === 'k') {
        e.preventDefault()
        setCursorIdx((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        const story = stories[cursorIdx]
        if (story) navigate(`/stories/${story.storyId}`)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [stories, cursorIdx, navigate])

  // Scroll cursor item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.querySelector<HTMLLIElement>(`[data-idx="${cursorIdx}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [cursorIdx])

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header>
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <span>Review queue</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Review queue</h1>
        <p className="mt-1 text-sm text-slate-500">
          Stories the agents have shipped to a PR and are waiting on a human
          decision. Use <kbd className="rounded border border-slate-300 px-1 text-xs">j</kbd>/
          <kbd className="rounded border border-slate-300 px-1 text-xs">k</kbd> to move,
          <kbd className="ml-1 rounded border border-slate-300 px-1 text-xs">Enter</kbd> to open.
        </p>
      </header>

      <CostDashboardWidget
        loading={costQuery.isLoading}
        data={costQuery.data ?? null}
      />

      <section className="flex flex-wrap items-center gap-3" aria-label="Filters">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StoryStatus)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span>Cost</span>
          <select
            value={costBandIdx}
            onChange={(e) => setCostBandIdx(Number(e.target.value))}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {COST_BANDS.map((b, i) => (
              <option key={b.label} value={i}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs text-slate-500">
          {stories.length} {stories.length === 1 ? 'story' : 'stories'}
        </span>
      </section>

      {listQuery.isLoading && <Skeleton className="h-40 w-full" />}
      {listQuery.isError && (
        <ErrorMessage message={listQuery.error?.message ?? 'Failed to load stories'} />
      )}

      {!listQuery.isLoading && !listQuery.isError && stories.length === 0 && (
        <EmptyState
          title="Nothing to review"
          description="No stories match the current filters. Adjust filters or check back soon."
        />
      )}

      {stories.length > 0 && (
        <ul
          ref={listRef}
          className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white"
          role="listbox"
          aria-label="Stories to review"
          data-testid="stories-list"
        >
          {stories.map((s, idx) => {
            const active = idx === cursorIdx
            return (
              <li
                key={s.storyId}
                data-idx={idx}
                data-testid={`story-row-${s.storyId}`}
                className={clsx(
                  'cursor-pointer p-4 transition',
                  active ? 'bg-brand-50/70 ring-1 ring-inset ring-brand-300' : 'hover:bg-slate-50',
                )}
                role="option"
                aria-selected={active}
                onClick={() => {
                  setCursorIdx(idx)
                  navigate(`/stories/${s.storyId}`)
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{s.title}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-700">
                      <Badge color={statusTone(s.status)}>{s.status.replace('_', ' ')}</Badge>
                      {s.priority && <span>P{s.priority}</span>}
                      {typeof s.storyPoints === 'number' && <span>{s.storyPoints} pts</span>}
                      <span className="ml-auto font-mono text-slate-700">
                        {formatUsd(s.totalCostUsd)}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cost dashboard widget
// ---------------------------------------------------------------------------

interface CostSummary {
  today_usd: number
  week_usd: number
  top: Array<{ story_id: string; title: string; total_usd: number }>
}

function CostDashboardWidget({
  loading,
  data,
}: {
  loading: boolean
  data: CostSummary | null
}) {
  if (loading || !data) {
    return <Skeleton className="h-24 w-full" />
  }
  return (
    <section
      aria-label="Cost dashboard"
      className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3"
    >
      <Stat label="Today" value={formatUsd(data.today_usd)} />
      <Stat label="This week" value={formatUsd(data.week_usd)} />
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-700">
          Top spenders
        </p>
        {data.top.length === 0 ? (
          <p className="mt-1 text-sm text-slate-400">No spend yet.</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
            {data.top.map((s) => (
              <li key={s.story_id} className="flex items-center justify-between gap-3">
                <span className="truncate">{s.title}</span>
                <span className="font-mono text-xs text-slate-600">
                  {formatUsd(s.total_usd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-700">{label}</p>
      <p className="mt-1 font-mono text-2xl text-slate-900">{value}</p>
    </div>
  )
}

function statusTone(status: string): 'amber' | 'blue' | 'emerald' | 'rose' | 'slate' {
  switch (status) {
    case 'in_review':
      return 'amber'
    case 'done':
    case 'accepted':
      return 'emerald'
    case 'blocked':
    case 'defective':
    case 'cancelled':
      return 'rose'
    case 'in_progress':
      return 'blue'
    default:
      return 'slate'
  }
}
