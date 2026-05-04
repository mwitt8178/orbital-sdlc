/**
 * MemoryEntryList — paginated, filterable list of project memory entries.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { useActiveProject } from '../../../services/use-active-project.js'
import { Spinner } from '../../ui/Spinner.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Badge } from '../../ui/Badge.js'

// ---------------------------------------------------------------------------
// Types (matching the backend schema)
// ---------------------------------------------------------------------------

export interface MemoryEntryListItem {
  entryId: string
  projectId: string
  kind: string
  title: string
  body: string
  sourceKind: string
  confidence: string
  scope: string
  scopeValue: string | null
  status: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Kind badge colours
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<string, string> = {
  decision: 'bg-blue-50 text-blue-700 ring-blue-700/10',
  convention: 'bg-emerald-50 text-emerald-700 ring-emerald-700/10',
  learning: 'bg-amber-50 text-amber-800 ring-amber-800/10',
  anti_pattern: 'bg-red-50 text-red-700 ring-red-600/10',
  glossary: 'bg-violet-50 text-violet-700 ring-violet-700/10',
}

interface KindBadgeProps {
  kind: string
}

function KindBadge({ kind }: KindBadgeProps) {
  const colorClass = KIND_COLORS[kind] ?? 'bg-slate-50 text-slate-700 ring-slate-700/10'
  const label = kind.replace('_', ' ')
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        colorClass,
      )}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MemoryEntryListProps {
  search: string
  kindFilter: string
  statusFilter: string
  onSelect: (entry: MemoryEntryListItem) => void
  selectedId: string | null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MemoryEntryList({
  search,
  kindFilter,
  statusFilter,
  onSelect,
  selectedId,
}: MemoryEntryListProps) {
  const [page, setPage] = useState(0)
  const pageSize = 20
  const { activeProject } = useActiveProject()
  const projectId = activeProject?.projectId

  const { data, isLoading, isError } = trpc.memory.list.useQuery(
    {
      projectId: projectId ?? '',
      search: search || undefined,
      kind: (kindFilter as 'decision' | 'convention' | 'learning' | 'anti_pattern' | 'glossary') || undefined,
      status: (statusFilter as 'active' | 'archived' | 'superseded') || 'active',
      limit: pageSize,
      offset: page * pageSize,
    },
    {
      enabled: !!projectId,
    },
  )

  if (!projectId) {
    return (
      <EmptyState
        title="No project selected"
        description="Select a project to view its memory."
      />
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="md" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load memory entries.
      </div>
    )
  }

  const entries = data?.entries ?? []
  const total = data?.total ?? 0

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No memory entries"
        description={
          search
            ? 'No entries match your search. Try a different query.'
            : 'No memory recorded yet. Agents will record decisions and conventions as they work.'
        }
      />
    )
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="flex flex-col gap-0">
      <div className="mb-2 px-2 text-xs text-slate-400">
        {total} {total === 1 ? 'entry' : 'entries'}
      </div>

      <ul role="list" className="divide-y divide-slate-100">
        {entries.map((entry) => (
          <li key={entry.entryId}>
            <button
              type="button"
              className={clsx(
                'w-full rounded-md px-3 py-3 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                selectedId === entry.entryId && 'bg-brand-50',
              )}
              onClick={() => onSelect(entry as MemoryEntryListItem)}
              aria-current={selectedId === entry.entryId ? 'true' : undefined}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <KindBadge kind={entry.kind} />
                    {entry.confidence === 'high' && (
                      <span className="text-xs text-emerald-600 font-medium">High confidence</span>
                    )}
                  </div>
                  <p className={clsx(
                    'text-sm font-medium truncate',
                    selectedId === entry.entryId ? 'text-brand-700' : 'text-slate-900',
                  )}>
                    {entry.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400 truncate">
                    {new Date(entry.createdAt).toLocaleDateString()} &middot; {entry.sourceKind}
                    {entry.scope !== 'project' && ` · ${entry.scope}${entry.scopeValue ? `: ${entry.scopeValue}` : ''}`}
                  </p>
                </div>
              </div>
              {entry.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {entry.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500"
                    >
                      {tag}
                    </span>
                  ))}
                  {entry.tags.length > 4 && (
                    <span className="text-[10px] text-slate-400">+{entry.tags.length - 4} more</span>
                  )}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between px-2">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-sm text-brand-600 disabled:text-slate-300 hover:underline"
          >
            Previous
          </button>
          <span className="text-xs text-slate-400">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="text-sm text-brand-600 disabled:text-slate-300 hover:underline"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
