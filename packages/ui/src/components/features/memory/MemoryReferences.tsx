/**
 * MemoryReferences — shows memory entries that were injected into a task's brief.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Embeds in TaskDetail / PRDetailPanel to show operators what context the
 * agent had when it worked on this task. Click to expand and see full body.
 *
 * Data source: queries `MemoryRetrievedForBrief` event for the task_id, then
 * loads the memory entries by the IDs listed in the event payload.
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { Spinner } from '../../ui/Spinner.js'

interface MemoryReferencesProps {
  /** The task_id whose brief we are inspecting */
  taskId: string
  /** Entry IDs that were injected (from MemoryRetrievedForBrief event payload) */
  entryIds: string[]
}

function MemoryReferenceItem({ entryId }: { entryId: string }) {
  const [expanded, setExpanded] = useState(false)

  const { data, isLoading, isError } = trpc.memory.get.useQuery({ entryId }, {
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <li className="flex items-center gap-2 py-1.5 text-xs text-slate-400">
        <Spinner size="sm" />
        <span>Loading…</span>
      </li>
    )
  }

  if (isError || !data?.entry) {
    return (
      <li className="py-1.5 text-xs text-slate-400">
        Entry {entryId.slice(0, 8)}… (not found)
      </li>
    )
  }

  const entry = data.entry

  const kindBadgeClass: Record<string, string> = {
    decision: 'bg-blue-50 text-blue-700',
    convention: 'bg-green-50 text-green-700',
    learning: 'bg-yellow-50 text-yellow-800',
    anti_pattern: 'bg-red-50 text-red-700',
    glossary: 'bg-purple-50 text-purple-700',
  }

  return (
    <li className="border-b border-slate-100 last:border-0">
      <button
        type="button"
        className="w-full py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={`Memory: ${entry.title}`}
      >
        <div className="flex items-start gap-2">
          <span
            className={clsx(
              'mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
              kindBadgeClass[entry.kind] ?? 'bg-slate-50 text-slate-600',
            )}
          >
            {entry.kind.replace('_', ' ')}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">{entry.title}</p>
            <p className="text-xs text-slate-400">
              {entry.confidence} confidence &middot; {entry.sourceKind}
            </p>
          </div>
          <span className="mt-1 flex-shrink-0 text-slate-400" aria-hidden="true">
            {expanded ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m18 15-6-6-6 6" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="pb-3 pt-1 pl-2">
          <div className="rounded bg-slate-50 px-3 py-2 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
            {entry.body}
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * MemoryReferences — shows memory entries injected into a task's brief.
 * Renders nothing if there are no entry IDs.
 */
export function MemoryReferences({ taskId: _taskId, entryIds }: MemoryReferencesProps) {
  if (entryIds.length === 0) return null

  return (
    <section aria-label="Project memory used in this task">
      <header className="mb-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          Project memory used
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            {entryIds.length}
          </span>
        </h3>
        <p className="mt-0.5 text-[11px] text-slate-400">
          These entries were in the agent&apos;s context when it worked on this task.
        </p>
      </header>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 bg-white">
        {entryIds.map((id) => (
          <MemoryReferenceItem key={id} entryId={id} />
        ))}
      </ul>
    </section>
  )
}
