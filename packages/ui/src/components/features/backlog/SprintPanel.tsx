/**
 * SprintPanel — right-rail panel showing all sprints (planning/active/completed)
 * grouped by status. Sprint cards are drop targets for stories.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useSprintsStore, type Sprint } from '../../../store/sprints.js'
import { Button } from '../../ui/Button.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { SprintCard } from './SprintCard.js'
import { CreateSprintModal } from './CreateSprintModal.js'

interface SprintRowLike {
  sprintId?: unknown
  sprint_id?: unknown
  name?: unknown
  status?: unknown
  startedAt?: unknown
  started_at?: unknown
  completedAt?: unknown
  completed_at?: unknown
  wallClockTargetMs?: unknown
  wall_clock_target_ms?: unknown
}

function toSprint(row: SprintRowLike): Sprint {
  const wct = row.wallClockTargetMs ?? row.wall_clock_target_ms
  const startedAt = row.startedAt ?? row.started_at
  const completedAt = row.completedAt ?? row.completed_at
  return {
    id: String(row.sprintId ?? row.sprint_id ?? ''),
    name: String(row.name ?? ''),
    status: (row.status as Sprint['status']) ?? 'planning',
    startedAt: startedAt
      ? startedAt instanceof Date
        ? startedAt.toISOString()
        : String(startedAt)
      : null,
    completedAt: completedAt
      ? completedAt instanceof Date
        ? completedAt.toISOString()
        : String(completedAt)
      : null,
    wallClockTargetMs: typeof wct === 'number' ? wct : wct ? Number(wct) : null,
  }
}

export function SprintPanel() {
  const setSprints = useSprintsStore((s) => s.setSprints)
  const sprints = useSprintsStore((s) => s.sprints)
  const [createOpen, setCreateOpen] = useState(false)

  const sprintsQuery = trpc.sprint.list.useQuery(undefined, { staleTime: 30_000 })

  useEffect(() => {
    if (!sprintsQuery.data) return
    const list = (sprintsQuery.data as SprintRowLike[]).map(toSprint)
    setSprints(list)
    // setSprints is a stable Zustand action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprintsQuery.data])

  const grouped = useMemo(() => {
    const planning: Sprint[] = []
    const ready: Sprint[] = []
    const active: Sprint[] = []
    const paused: Sprint[] = []
    const completed: Sprint[] = []
    for (const s of sprints) {
      if (s.status === 'planning') planning.push(s)
      else if (s.status === 'ready') ready.push(s)
      else if (s.status === 'active' || s.status === 'completing') active.push(s)
      else if (s.status === 'paused') paused.push(s)
      else completed.push(s)
    }
    return { planning, ready, active, paused, completed }
  }, [sprints])

  return (
    <aside className="space-y-4" aria-label="Sprints">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Sprints</h2>
        <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
          + New
        </Button>
      </header>

      {sprintsQuery.isLoading ? (
        <Skeleton rows={4} />
      ) : sprintsQuery.error ? (
        <ErrorMessage
          title="Could not load sprints"
          message={sprintsQuery.error.message}
        />
      ) : sprints.length === 0 ? (
        <EmptyState
          title="No sprints yet"
          description="Sprints commit a slice of the backlog to a time-boxed run."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              + Create your first sprint
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {grouped.active.length > 0 && (
            <SprintGroup label="Active" sprints={grouped.active} />
          )}
          {grouped.paused.length > 0 && (
            <SprintGroup label="Paused" sprints={grouped.paused} />
          )}
          {grouped.ready.length > 0 && (
            <SprintGroup label="Ready" sprints={grouped.ready} />
          )}
          {grouped.planning.length > 0 && (
            <SprintGroup label="Planning" sprints={grouped.planning} />
          )}
          {grouped.completed.length > 0 && (
            <SprintGroup label="Completed" sprints={grouped.completed.slice(0, 3)} />
          )}
        </div>
      )}

      {createOpen && <CreateSprintModal onClose={() => setCreateOpen(false)} />}
    </aside>
  )
}

function SprintGroup({ label, sprints }: { label: string; sprints: Sprint[] }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <div className="space-y-2">
        {sprints.map((s) => (
          <SprintCard key={s.id} sprint={s} />
        ))}
      </div>
    </div>
  )
}
