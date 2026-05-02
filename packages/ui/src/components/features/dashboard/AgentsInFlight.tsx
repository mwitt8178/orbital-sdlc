/**
 * AgentsInFlight — list of currently active agent workers.
 *
 * Hydrates from orchestration.workers.list on mount, then mirrors live state
 * from the workers store as Heartbeat / Spawned / Completed events arrive.
 */

import { Link } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'
import { useWorkersStore, type WorkerView } from '../../../store/workers.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { SkeletonCard } from '../../ui/Skeleton.js'
import { PulseDot } from '../../ui/PulseDot.js'
import { Badge } from '../../ui/Badge.js'
import { AgentLiveOutput } from './AgentLiveOutput.js'
import { useEffect, useMemo, useState } from 'react'

export function AgentsInFlight() {
  const setWorkers = useWorkersStore((s) => s.setWorkers)
  const workersById = useWorkersStore((s) => s.workersById)
  const workers = useMemo(
    () =>
      Object.values(workersById)
        .filter(
          (w) => w.status === 'active' || w.status === 'idle' || w.status === 'connecting',
        )
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [workersById],
  )

  const query = trpc.orchestration.workers.list.useQuery({
    status: ['active', 'idle', 'connecting'],
    limit: 50,
  })

  // Round 5D: load tasks so we can show PR badge on worker cards.
  const tasksQuery = trpc.orchestration.tasks.list.useQuery(
    { state: ['in_progress', 'in_review', 'done'], limit: 100 },
    { staleTime: 30_000 },
  )
  const prByTaskId = useMemo(() => {
    const map: Record<string, { pr_number: number; pr_url: string | null; merged: boolean }> = {}
    for (const t of tasksQuery.data?.items ?? []) {
      const taskId = (t as { taskId?: string }).taskId ?? ''
      const prNumber = (t as { githubPrNumber?: number | null }).githubPrNumber
      if (taskId && prNumber) {
        map[taskId] = {
          pr_number: prNumber,
          pr_url: ((t as { githubPrUrl?: string | null }).githubPrUrl) ?? null,
          merged: !!(t as { githubPrMergedAt?: string | null }).githubPrMergedAt,
        }
      }
    }
    return map
  }, [tasksQuery.data])

  useEffect(() => {
    if (!query.data) return
    const mapped: WorkerView[] = query.data.items.map((row) => ({
      workerId: row.workerId,
      taskId: row.taskId,
      personaRole: row.personaId,
      model: null,
      status: row.status as WorkerView['status'],
      startedAt: toIso(row.startedAt),
      lastHeartbeatAt: row.lastHeartbeatAt ? toIso(row.lastHeartbeatAt) : null,
      currentFile: null,
    }))
    setWorkers(mapped)
    // setWorkers is a stable Zustand action; only re-run on upstream change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data])

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  if (query.error) {
    return (
      <ErrorMessage
        title="Could not load workers"
        message={query.error.message}
      />
    )
  }

  if (workers.length === 0) {
    return (
      <div
        role="status"
        className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center"
      >
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-slate-900">No agents in flight</h3>
        <p className="mt-1 max-w-xs text-xs text-slate-500">
          Define a vision, then start a sprint to see agents work.
        </p>
        <Link
          to="/vision"
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          Open Vision Intake →
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-2" role="list" aria-label="Agents in flight">
      {workers.map((w) => (
        <AgentCard
          key={w.workerId}
          worker={w}
          pr={w.taskId ? prByTaskId[w.taskId] ?? null : null}
        />
      ))}
    </div>
  )
}

interface PRBadgeInfo {
  pr_number: number
  pr_url: string | null
  merged: boolean
}

function AgentCard({ worker, pr }: { worker: WorkerView; pr: PRBadgeInfo | null }) {
  const isLive = worker.status === 'active' || worker.status === 'connecting'
  const [outputOpen, setOutputOpen] = useState(false)

  return (
    <div role="listitem" className="rounded-lg border border-slate-200 bg-white p-4 animate-stream-in">
      <div className="mb-2 flex items-start gap-2.5">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white">
          {(worker.personaRole ?? 'A').slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">
              {worker.personaRole ?? 'Agent'}
            </p>
            {worker.model && (
              <span className="font-mono text-[10px] text-slate-400">{worker.model}</span>
            )}
          </div>
          <p className="truncate text-xs text-slate-500" title={worker.taskId ?? ''}>
            {worker.taskId ? `task ${worker.taskId.slice(0, 8)}` : 'no task assigned'}
          </p>
        </div>
        <StatusPill status={worker.status} live={isLive} />
      </div>
      {worker.currentFile && (
        <div className="mt-2 flex items-center gap-1.5 rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="truncate">{worker.currentFile}</span>
        </div>
      )}
      {pr && (
        <a
          href={pr.pr_url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="agent-card-pr-badge"
          className="mt-2 flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <line x1="6" y1="9" x2="6" y2="21" />
          </svg>
          <span>PR #{pr.pr_number}</span>
          <span
            className={
              pr.merged
                ? 'rounded-full bg-violet-100 px-1.5 text-[9px] font-semibold text-violet-700'
                : 'rounded-full bg-emerald-100 px-1.5 text-[9px] font-semibold text-emerald-700'
            }
          >
            {pr.merged ? 'merged' : 'open'}
          </span>
        </a>
      )}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => setOutputOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
          aria-label={`View live output for worker ${worker.workerId}`}
          data-testid="agent-card-view-output"
        >
          View live output
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <AgentLiveOutput
        workerId={worker.workerId}
        open={outputOpen}
        onClose={() => setOutputOpen(false)}
        personaLabel={worker.personaRole ?? undefined}
        taskId={worker.taskId}
      />
    </div>
  )
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function StatusPill({ status, live }: { status: WorkerView['status']; live: boolean }) {
  const colorMap: Record<WorkerView['status'], 'emerald' | 'blue' | 'amber' | 'slate'> = {
    active: 'emerald',
    connecting: 'blue',
    idle: 'amber',
    terminating: 'slate',
    terminated: 'slate',
  }
  const color = colorMap[status]
  return (
    <Badge color={color} className="flex items-center gap-1">
      {live && <PulseDot color={color} size="sm" />}
      {status}
    </Badge>
  )
}
