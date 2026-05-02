/**
 * ChannelList — left rail listing of channels.
 *
 * Hydrates from channel.list and tracks the active channel selection.
 */

import { useEffect, useState, useMemo } from 'react'
import { trpc } from '../../../services/trpc.js'
import {
  useChannelsStore,
  type Channel as StoreChannel,
} from '../../../store/channels.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

export function ChannelList() {
  const channels = useChannelsStore((s) => s.channels)
  const setChannels = useChannelsStore((s) => s.setChannels)
  const activeChannelId = useChannelsStore((s) => s.activeChannelId)
  const setActiveChannelId = useChannelsStore((s) => s.setActiveChannelId)

  const [filter, setFilter] = useState('')

  const query = trpc.channel.list.useQuery({
    include_archived: false,
    limit: 100,
  })

  useEffect(() => {
    if (!query.data) return
    const mapped: StoreChannel[] = query.data.items.map((row) => ({
      id: row.channel_id,
      name: row.name,
      kind: row.kind,
      unreadCount: 0,
    }))
    setChannels(mapped)
    if (!activeChannelId && mapped.length > 0) {
      setActiveChannelId(mapped[0]!.id)
    }
    // setChannels and setActiveChannelId are stable Zustand actions; we only
    // re-run when the upstream data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data])

  const filteredChannels = useMemo(() => {
    if (!filter) return channels
    const lower = filter.toLowerCase()
    return channels.filter((c) => c.name.toLowerCase().includes(lower))
  }, [channels, filter])

  return (
    <aside
      className="scrollbar-thin flex w-64 flex-shrink-0 flex-col border-r border-slate-200 bg-slate-100"
      aria-label="Channel list"
    >
      <div className="border-b border-slate-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-900">Channels</div>
        </div>
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter channels…"
            className="w-full rounded border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
            aria-label="Filter channels"
          />
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto py-2">
        {query.isLoading ? (
          <div className="space-y-2 px-3">
            <Skeleton rows={4} />
          </div>
        ) : query.error ? (
          <ErrorMessage title="Could not load channels" message={query.error.message} />
        ) : filteredChannels.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-slate-400">
            {filter
              ? `No channels match "${filter}".`
              : 'No channels yet. Start a sprint to see channels.'}
          </div>
        ) : (
          filteredChannels.map((ch) => (
            <button
              type="button"
              key={ch.id}
              onClick={() => setActiveChannelId(ch.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                ch.id === activeChannelId ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-200/60 text-slate-700'
              }`}
              aria-current={ch.id === activeChannelId ? 'true' : undefined}
            >
              <span className="text-slate-400" aria-hidden="true">
                #
              </span>
              <span className="truncate">{ch.name}</span>
              {ch.unreadCount > 0 && (
                <span className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {ch.unreadCount}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
