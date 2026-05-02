/**
 * ActivityStream — recent events feed.
 *
 * Reads the rolling event ring populated from the WS stream. Renders the
 * newest events at the top; uses role=status aria-live=polite so assistive
 * tech announces newly-streamed activity.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useEventsStore } from '../../../store/events.js'
import type { EventEnvelope } from '@orbital/types'

export function ActivityStream() {
  const events = useEventsStore((s) => s.events)
  const recent = useMemo(() => [...events].reverse().slice(0, 50), [events])

  if (recent.length === 0) {
    return <ActivityStreamEmptyState />
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Activity stream"
      className="max-h-[600px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 scrollbar-thin"
    >
      <ol className="divide-y divide-slate-100">
        {recent.map((ev) => (
          <li key={ev.event_id} className="px-3 py-2 animate-stream-in">
            <ActivityRow event={ev} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function ActivityRow({ event }: { event: EventEnvelope }) {
  const time = new Date(event.occurred_at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const actorLabel = formatActor(event.actor)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] font-medium text-indigo-600">
          {event.event_type}
        </span>
        <span className="font-mono text-[10px] text-slate-400">{time}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-xs text-slate-600">
        <span className="text-slate-500">{event.aggregate_type}</span>
        <span className="text-slate-300" aria-hidden="true">
          ·
        </span>
        <span className="truncate text-slate-400" title={event.aggregate_id}>
          {event.aggregate_id.slice(0, 8)}
        </span>
        <span className="text-slate-300" aria-hidden="true">
          ·
        </span>
        <span className="truncate">{actorLabel}</span>
      </div>
    </div>
  )
}

function formatActor(actor: EventEnvelope['actor']): string {
  if (!actor || typeof actor !== 'object') return 'unknown'
  const a = actor as Record<string, unknown>
  if (a['type'] === 'persona' && typeof a['persona_role'] === 'string') {
    return `persona ${a['persona_role']}`
  }
  if (a['type'] === 'user' && typeof a['user_id'] === 'string') {
    return `user ${a['user_id']}`
  }
  if (a['type'] === 'system' && typeof a['component'] === 'string') {
    return `system ${a['component']}`
  }
  if (a['type'] === 'hook' && typeof a['hook_id'] === 'string') {
    return `hook ${a['hook_id']}`
  }
  return String(a['type'] ?? 'unknown')
}

/**
 * Empty state for the activity stream — illustrates what events look like
 * via a hover-revealed preview, then directs the user toward Vision.
 */
function ActivityStreamEmptyState() {
  const [showPreview, setShowPreview] = useState(false)

  const sampleEvents = [
    { eventType: 'TaskStarted', aggregateType: 'task', actor: 'persona engineer-sr', time: '14:02' },
    { eventType: 'VerifierCheckPassed', aggregateType: 'task', actor: 'persona verifier-test', time: '14:04' },
    { eventType: 'TaskCompleted', aggregateType: 'task', actor: 'persona engineer-sr', time: '14:09' },
  ]

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-dashed border-slate-200 bg-white"
    >
      <div className="px-4 py-8 text-center">
        <h3 className="text-sm font-semibold text-slate-900">No events yet</h3>
        <p className="mx-auto mt-1 max-w-xs text-xs text-slate-500">
          Events stream here as agents work.
        </p>
        <button
          type="button"
          onMouseEnter={() => setShowPreview(true)}
          onMouseLeave={() => setShowPreview(false)}
          onFocus={() => setShowPreview(true)}
          onBlur={() => setShowPreview(false)}
          className="mt-3 text-xs font-medium text-brand-600 hover:text-brand-700 focus:outline-none focus-visible:underline"
          aria-describedby="activity-empty-preview"
        >
          See an example →
        </button>
      </div>

      <div
        id="activity-empty-preview"
        className={`overflow-hidden border-t border-dashed border-slate-200 transition-all ${
          showPreview ? 'max-h-60 opacity-100' : 'max-h-0 opacity-0'
        }`}
        aria-hidden={!showPreview}
      >
        <ol className="divide-y divide-slate-100 p-1">
          {sampleEvents.map((ev) => (
            <li key={ev.eventType} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] font-medium text-indigo-600">
                  {ev.eventType}
                </span>
                <span className="font-mono text-[10px] text-slate-400">{ev.time}</span>
              </div>
              <div className="mt-0.5 flex items-baseline gap-2 text-xs text-slate-600">
                <span className="text-slate-500">{ev.aggregateType}</span>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <span className="truncate">{ev.actor}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="border-t border-slate-100 px-3 py-2 text-center">
          <Link
            to="/vision"
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Define a vision to start →
          </Link>
        </div>
      </div>
    </div>
  )
}
