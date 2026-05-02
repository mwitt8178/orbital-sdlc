/**
 * ExportProgressList — recent audit exports with progress / download links.
 */

import { trpc } from '../../../services/trpc.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Badge } from '../../ui/Badge.js'

export function ExportProgressList() {
  const query = trpc.auditExport.export.list.useQuery(
    { limit: 10 },
    { refetchInterval: 5_000 },
  )

  if (query.isLoading) {
    return <Skeleton rows={3} />
  }
  if (query.error) {
    return <ErrorMessage title="Could not load exports" message={query.error.message} />
  }
  const items = query.data?.items ?? []
  if (items.length === 0) {
    return (
      <EmptyState
        title="No exports yet"
        description="Click Export above to request an immutable audit package."
      />
    )
  }

  return (
    <ul className="space-y-2" role="list">
      {items.map((exp) => (
        <li
          key={exp.export_id}
          role="listitem"
          className="flex items-center justify-between rounded border border-slate-200 bg-white p-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-slate-500">
                {exp.export_id.slice(0, 8)}
              </span>
              <Badge color={statusColor(exp.status)}>{exp.status}</Badge>
              {exp.progress_stage && (
                <span className="text-[11px] text-slate-500">{exp.progress_stage}</span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-600">
              {new Date(exp.range_start).toLocaleDateString()} →{' '}
              {new Date(exp.range_end).toLocaleDateString()} · {exp.scope_summary}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {exp.status === 'running' && exp.progress_percent !== null && (
              <div className="w-24">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full bg-indigo-500"
                    style={{ width: `${exp.progress_percent}%` }}
                  />
                </div>
                <div className="mt-0.5 text-right font-mono text-[10px] text-slate-500">
                  {exp.progress_percent}%
                </div>
              </div>
            )}
            {exp.status === 'completed' && exp.download_url && (
              <a
                href={exp.download_url}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Download
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

function statusColor(
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
): 'amber' | 'blue' | 'emerald' | 'rose' | 'slate' {
  switch (status) {
    case 'pending':
      return 'amber'
    case 'running':
      return 'blue'
    case 'completed':
      return 'emerald'
    case 'failed':
      return 'rose'
    default:
      return 'slate'
  }
}
