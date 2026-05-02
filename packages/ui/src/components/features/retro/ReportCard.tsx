/**
 * ReportCard — sprint retro summary card.
 */

import { trpc } from '../../../services/trpc.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Badge } from '../../ui/Badge.js'

interface ReportCardProps {
  reportId: string
}

export function ReportCard({ reportId }: ReportCardProps) {
  const query = trpc.retro.report.get.useQuery({ retro_report_id: reportId })

  if (query.isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <Skeleton rows={4} />
      </div>
    )
  }

  if (query.error) {
    return <ErrorMessage title="Could not load report" message={query.error.message} />
  }

  const data = query.data
  if (!data) {
    return (
      <EmptyState title="Report not found" description="The retro report could not be loaded." />
    )
  }

  const { report } = data

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Sprint Report</div>
          <div className="mt-0.5 text-xs text-slate-500">
            run #{report.analysis_run_seq} · started{' '}
            {new Date(report.started_at).toLocaleString()}
          </div>
        </div>
        <Badge color={report.status === 'closed' ? 'emerald' : 'amber'}>{report.status}</Badge>
      </div>

      <div className="grid grid-cols-4 gap-3 text-center">
        <Stat label="Proposals" value={report.proposal_count} />
        <Stat label="Approved" value={report.approved_count} color="emerald" />
        <Stat label="Rejected" value={report.rejected_count} color="rose" />
        <Stat label="Deferred" value={report.deferred_count} color="amber" />
      </div>

      {report.failure_reason && (
        <p className="mt-3 text-xs text-rose-600">Failure: {report.failure_reason}</p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  color = 'slate',
}: {
  label: string
  value: number
  color?: 'emerald' | 'rose' | 'amber' | 'slate'
}) {
  const colorMap = {
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
    amber: 'text-amber-600',
    slate: 'text-slate-900',
  } as const
  return (
    <div className="rounded-md bg-slate-50 p-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${colorMap[color]}`}>{value}</div>
    </div>
  )
}
