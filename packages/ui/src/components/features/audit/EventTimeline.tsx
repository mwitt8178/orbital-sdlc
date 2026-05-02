/**
 * EventTimeline — cursor-paginated, filterable audit event list.
 *
 * Filter UX:
 *   - Free-text aggregate-id search (existing).
 *   - Chip-style filters from <AuditFilterChips> for aggregate type,
 *     date range presets, and actor type.
 *   - Decrypt-instructions modal trigger (for users restoring export tarballs).
 */

import { useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import type { EventEnvelope } from '@orbital/types'
import { AuditFilterChips, type AuditFilters, type ActorType } from './AuditFilterChips.js'
import { DecryptInstructionsModal } from './DecryptInstructionsModal.js'
// Round 7-08 — Operator-Attributed UI: actor column badge
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../../identity/OperatorBadge.js'

const INITIAL_FILTERS: AuditFilters = {
  aggregateTypes: [],
  actorTypes: [],
  rangePreset: 'all',
}

// Round 6 #7 — when an event row carries one of these types, the row may
// have an attached replay capture. We filter the 🔁 icon resolution to these
// types to avoid hitting replay.list for every row.
// [Engineer-Principal · Opus · run-round6-07-replay]
const REPLAY_BEARING_EVENT_TYPES = new Set([
  'ReplayCaptureCompleted',
  'ToolCallCompleted',
  'LLMRequestCompleted',
])

interface EventTimelineProps {
  /** Round 6 #7 — invoked with a capture_id when the operator clicks the 🔁 icon. */
  onOpenReplay?: (captureId: string) => void
}

export function EventTimeline({ onOpenReplay }: EventTimelineProps = {}) {
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS)
  const [searchText, setSearchText] = useState('')
  const [decryptOpen, setDecryptOpen] = useState(false)
  // Round 6 #7 — filter to events that have a replay capture attached.
  const [hasReplayOnly, setHasReplayOnly] = useState(false)
  // Round 7-08 — Operator-Attributed UI: team member lookup for actor column
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 60_000 })
  const memberMap = useMemo(() => {
    const map = new Map<string, TeamMember>()
    for (const m of (membersQuery.data ?? [])) {
      map.set(m.install_id, {
        install_id: m.install_id,
        display_name: m.display_name,
        role: m.role,
        last_seen_at: m.last_seen_at,
        color: m.color,
      })
    }
    return map
  }, [membersQuery.data])

  // Server only accepts a single aggregate_type / actor_type per query, so for
  // the multi-select case we issue a query for the FIRST selected value and
  // post-filter client-side. With the typical small page size (100) this
  // tradeoff is acceptable; a future server enhancement could support arrays.
  const queryFilters = useMemo<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = { limit: 100 }
    if (filters.aggregateTypes.length > 0) {
      out['aggregate_type'] = filters.aggregateTypes[0]
    }
    if (filters.actorTypes.length > 0) {
      out['actor_type'] = filters.actorTypes[0]
    }
    if (searchText.trim()) out['aggregate_id'] = searchText.trim()
    if (filters.occurredAfter) out['occurred_after'] = filters.occurredAfter
    if (filters.occurredBefore) out['occurred_before'] = filters.occurredBefore
    return out
  }, [filters, searchText])

  const query = trpc.audit.events.query.useQuery({ filters: queryFilters })

  const items = useMemo<EventEnvelope[]>(() => {
    const raw = (query.data?.items ?? []) as EventEnvelope[]
    if (filters.aggregateTypes.length <= 1 && filters.actorTypes.length <= 1) return raw
    return raw.filter((event) => {
      if (filters.aggregateTypes.length > 1) {
        if (!filters.aggregateTypes.includes(event.aggregate_type)) return false
      }
      if (filters.actorTypes.length > 1) {
        const actorType = (event.actor as { type?: ActorType })?.type
        if (!actorType || !filters.actorTypes.includes(actorType)) return false
      }
      return true
    })
  }, [query.data, filters])

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-5 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-900">Event Timeline</div>
            <div className="mt-0.5 text-xs text-slate-500">Cursor-paginated · newest first</div>
          </div>
          <button
            type="button"
            onClick={() => setDecryptOpen(true)}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Decrypt instructions
          </button>
        </div>

        <div className="mt-3 space-y-3">
          <input
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Filter by aggregate id…"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm placeholder-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Filter audit events by aggregate id"
          />
          <AuditFilterChips filters={filters} onChange={setFilters} />
          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={hasReplayOnly}
              onChange={(e) => setHasReplayOnly(e.target.checked)}
              className="rounded border-slate-300"
              aria-label="Filter to events with a replay capture"
            />
            Has replay capture
          </label>
        </div>
      </div>

      <div className="px-5 py-4">
        {query.isLoading ? (
          <Skeleton rows={6} />
        ) : query.error ? (
          <ErrorMessage title="Could not load events" message={query.error.message} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            }
            title="No events match your filters"
            description="Try widening the date range or clearing the filter."
          />
        ) : (
          <ol className="divide-y divide-slate-100">
            {items
              .filter(() => true) // pre-replay-filter slot for future server-side filtering
              .map((event) => (
                <EventRow
                  key={event.event_id}
                  event={event}
                  onOpenReplay={onOpenReplay}
                  hasReplayOnly={hasReplayOnly}
                  memberMap={memberMap}
                />
              ))}
          </ol>
        )}
      </div>

      <DecryptInstructionsModal open={decryptOpen} onClose={() => setDecryptOpen(false)} />
    </div>
  )
}

function EventRow({
  event,
  onOpenReplay,
  hasReplayOnly,
  memberMap,
}: {
  event: EventEnvelope
  onOpenReplay?: (captureId: string) => void
  hasReplayOnly: boolean
  memberMap: Map<string, TeamMember>
}) {
  // Round 6 #7 — try to resolve a replay capture for this event. We only
  // call replay.list for event types that may bear a capture so we don't
  // chatter the API. The trpc client batches identical queries so duplicate
  // event rows still produce one network call.
  // [Engineer-Principal · Opus · run-round6-07-replay]
  const enabled = REPLAY_BEARING_EVENT_TYPES.has(event.event_type)
  const replayQ = (
    trpc as unknown as {
      replay: {
        list: {
          useQuery: (
            input: { event_id: string; limit: number },
            opts: { enabled: boolean; staleTime?: number },
          ) => { data?: { items: Array<{ capture_id: string }> } }
        }
      }
    }
  ).replay.list.useQuery(
    { event_id: event.event_id, limit: 1 },
    { enabled, staleTime: 30_000 },
  )
  const captureId = replayQ.data?.items?.[0]?.capture_id ?? null

  // When the "Has replay capture" filter is active, hide rows with no
  // capture attached. We render an empty placeholder so React keeps the
  // row order stable while the queries resolve.
  if (hasReplayOnly && !captureId) {
    return null
  }

  return (
    <li className="grid grid-cols-12 gap-3 py-2 text-sm">
      <div className="col-span-3 font-mono text-xs text-slate-400">
        {new Date(event.occurred_at).toLocaleString()}
      </div>
      <div className="col-span-3 font-mono text-xs">
        <span className="text-slate-500">{event.aggregate_type}</span>
        <span className="text-slate-300" aria-hidden="true">
          {' · '}
        </span>
        <span className="text-slate-700">{event.aggregate_id.slice(0, 8)}</span>
      </div>
      <div className="col-span-3 truncate font-mono text-xs font-medium text-indigo-600">
        {event.event_type}
      </div>
      <div className="col-span-2 truncate text-xs text-slate-500">
        {/* Round 7-08 — show OperatorBadge when actor.install_id is known */}
        {(() => {
          const actor = event.actor as Record<string, unknown>
          const installId = actor?.['install_id'] as string | undefined
          if (installId) {
            const member = memberMap.get(installId)
            return (
              <OperatorBadge
                installId={installId}
                member={member}
                size="sm"
              />
            )
          }
          return <span>{String(actor?.['type'] ?? 'system')}</span>
        })()}
      </div>
      <div className="col-span-1 text-right text-xs">
        {captureId ? (
          <button
            type="button"
            onClick={() => onOpenReplay?.(captureId)}
            aria-label="Open replay drawer"
            title="Replay this event"
            className="rounded px-1 text-base hover:bg-slate-100"
          >
            {'\u{1F501}'}
          </button>
        ) : null}
      </div>
    </li>
  )
}
