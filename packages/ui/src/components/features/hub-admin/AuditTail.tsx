/**
 * hub-admin/AuditTail.tsx — Hub audit event stream panel.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Fetches GET /admin/audit-tail. Auto-refreshes every 10s.
 * Supports filtering by event type prefix and the `since` timestamp.
 */

import { useEffect, useState, useCallback } from 'react'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

interface AuditEvent {
  eventId: string
  eventType: string
  actorType: string
  actorId: string
  tenantId: string
  occurredAt: string
  payload: Record<string, unknown>
}

interface Props {
  ownerToken: string | null
}

const REFRESH_MS = 10_000

export function AuditTail({ ownerToken }: Props) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const headers: HeadersInit = ownerToken
    ? { 'x-orbital-owner-token': ownerToken }
    : {}

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/admin/audit-tail?limit=100', { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const json = await res.json() as { events: AuditEvent[] }
      setEvents(json.events)
      setError(null)
    } catch (err) {
      setError((err as Error).message ?? 'Could not load audit events')
    } finally {
      setLoading(false)
    }
  }, [ownerToken])

  useEffect(() => {
    void fetchEvents()
    const interval = setInterval(() => void fetchEvents(), REFRESH_MS)
    return () => clearInterval(interval)
  }, [fetchEvents])

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (error) {
    return <ErrorMessage message={error} />
  }

  const allEvents = events ?? []
  const filtered = filter.length > 0
    ? allEvents.filter((e) => e.eventType.startsWith(filter.trim()))
    : allEvents

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by event type prefix (e.g. hub.)"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          aria-label="Filter audit events"
        />
        <span className="text-xs text-slate-500">
          {filtered.length} / {allEvents.length} events
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audit events match this filter.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-2 font-medium text-slate-600">Time</th>
                  <th className="px-4 py-2 font-medium text-slate-600">Event type</th>
                  <th className="px-4 py-2 font-medium text-slate-600">Actor</th>
                  <th className="px-4 py-2 font-medium text-slate-600">Tenant</th>
                  <th className="px-4 py-2 font-medium text-slate-600" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((event) => (
                  <>
                    <tr
                      key={event.eventId}
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() =>
                        setExpanded((prev) => (prev === event.eventId ? null : event.eventId))
                      }
                      aria-expanded={expanded === event.eventId}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">
                        {new Date(event.occurredAt).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs font-medium text-slate-900">
                        {event.eventType}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">
                        <span className="font-medium">{event.actorType}</span>
                        <span className="mx-1 text-slate-400">/</span>
                        <span className="font-mono">{event.actorId.slice(0, 12)}...</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-400">
                        {event.tenantId.slice(0, 8)}...
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-400">
                        {expanded === event.eventId ? '▲' : '▼'}
                      </td>
                    </tr>
                    {expanded === event.eventId && (
                      <tr key={`${event.eventId}-detail`}>
                        <td colSpan={5} className="bg-slate-50 px-4 py-3">
                          <pre className="overflow-x-auto rounded text-xs text-slate-700">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
