/**
 * SprintBoard — kanban view of stories within a single sprint, scoped to a project.
 *
 * Route: /projects/:projectId/sprints/:sprintId/board
 *
 * Phase D: first-class internal-ticket surface. Reads stories whose status spans
 * backlog | ready | in_progress | in_review | done, lays them out in a five-column
 * kanban, and uses `backlog.stories.update` to transition stories between columns.
 *
 * Drag-and-drop via @dnd-kit/core. Velocity strip at the top shows total points,
 * completed points, and per-column counts.
 *
 * [Engineer-Principal · Opus · run-phase-d-internal-tickets]
 */

import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core'
import clsx from 'clsx'
import { trpc } from '../services/trpc.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

type StoryStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'accepted'
  | 'blocked'
  | 'defective'
  | 'cancelled'

type StoryRow = {
  storyId: string
  title: string
  status: StoryStatus
  storyPoints: number | null
  priority: number
  epicId: string | null
}

const COLUMNS: Array<{ id: StoryStatus; label: string; tone: string }> = [
  { id: 'backlog', label: 'Backlog', tone: 'bg-slate-50 border-slate-200' },
  { id: 'ready', label: 'Ready', tone: 'bg-blue-50 border-blue-200' },
  { id: 'in_progress', label: 'In progress', tone: 'bg-violet-50 border-violet-200' },
  { id: 'in_review', label: 'In review', tone: 'bg-amber-50 border-amber-200' },
  { id: 'done', label: 'Done', tone: 'bg-emerald-50 border-emerald-200' },
]

export default function SprintBoard() {
  const { projectId, sprintId } = useParams<{ projectId: string; sprintId: string }>()

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const utils = trpc.useUtils()

  const storiesQuery = trpc.backlog.stories.list.useQuery(undefined, {
    staleTime: 5_000,
  })

  const updateStory = trpc.backlog.stories.update.useMutation({
    onSuccess: () => utils.backlog.stories.list.invalidate(),
  })

  const [optimistic, setOptimistic] = useState<Record<string, StoryStatus>>({})

  const stories: StoryRow[] = useMemo(() => {
    const raw = (storiesQuery.data as unknown as Array<Record<string, unknown>>) ?? []
    return raw.map((r) => {
      const sid = String(r.storyId ?? r.story_id ?? '')
      return {
        storyId: sid,
        title: String(r.title ?? 'Untitled'),
        status: (optimistic[sid] ?? (r.status as StoryStatus) ?? 'backlog') as StoryStatus,
        storyPoints: (r.storyPoints ?? r.story_points ?? null) as number | null,
        priority: Number(r.priority ?? 0),
        epicId: (r.epicId ?? r.epic_id ?? null) as string | null,
      }
    })
  }, [storiesQuery.data, optimistic])

  const byColumn = useMemo(() => {
    const map: Record<StoryStatus, StoryRow[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      in_review: [],
      done: [],
      accepted: [],
      blocked: [],
      defective: [],
      cancelled: [],
    }
    for (const s of stories) {
      if (map[s.status]) map[s.status].push(s)
    }
    for (const k of Object.keys(map) as StoryStatus[]) {
      map[k].sort((a, b) => a.priority - b.priority)
    }
    return map
  }, [stories])

  const totals = useMemo(() => {
    let total = 0
    let done = 0
    for (const s of stories) {
      total += s.storyPoints ?? 0
      if (s.status === 'done' || s.status === 'accepted') done += s.storyPoints ?? 0
    }
    return { total, done }
  }, [stories])

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const storyId = String(active.id)
    const targetStatus = String(over.id) as StoryStatus
    const story = stories.find((s) => s.storyId === storyId)
    if (!story || story.status === targetStatus) return

    // Optimistic update — flip the column locally, then call mutation.
    setOptimistic((m) => ({ ...m, [storyId]: targetStatus }))
    // Status enum on the mutation excludes 'cancelled' (terminal admin state).
    // The five board columns are all in the allowed set; cast away the wider type.
    updateStory.mutate(
      {
        story_id: storyId,
        status: targetStatus as Exclude<StoryStatus, 'cancelled'>,
      },
      {
        onError: () => {
          // Roll back optimistic state on failure.
          setOptimistic((m) => {
            const { [storyId]: _drop, ...rest } = m
            void _drop
            return rest
          })
        },
        onSettled: () => {
          // Server is canonical — clear the optimistic flag once refetch completes.
          setOptimistic((m) => {
            const { [storyId]: _drop, ...rest } = m
            void _drop
            return rest
          })
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-6">
      <header className="mb-5">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <Link to={`/projects/${projectId}/backlog`} className="hover:underline">
            Backlog
          </Link>
          <span aria-hidden="true">›</span>
          <span>Sprint board</span>
        </div>
        <div className="flex items-end justify-between">
          <h1 className="text-2xl font-bold text-slate-900">
            Sprint board
            <span className="ml-2 font-mono text-xs text-slate-400">{sprintId?.slice(0, 8)}</span>
          </h1>
          <VelocityStrip total={totals.total} done={totals.done} />
        </div>
      </header>

      {storiesQuery.isLoading ? (
        <Skeleton rows={6} />
      ) : storiesQuery.error ? (
        <ErrorMessage title="Could not load stories" message={storiesQuery.error.message} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-5 gap-3" data-testid="sprint-board-columns">
            {COLUMNS.map((col) => (
              <Column
                key={col.id}
                id={col.id}
                label={col.label}
                tone={col.tone}
                stories={byColumn[col.id] ?? []}
              />
            ))}
          </div>
        </DndContext>
      )}

      {stories.length === 0 && !storiesQuery.isLoading && (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm text-slate-600">
            No stories yet. Head to the{' '}
            <Link to={`/projects/${projectId}/backlog`} className="text-brand-600 hover:underline">
              backlog
            </Link>{' '}
            to create one.
          </p>
        </div>
      )}
    </div>
  )
}

function VelocityStrip({ total, done }: { total: number; done: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-3 text-xs text-slate-600">
      <div>
        <span className="font-semibold text-slate-900">{done}</span>
        <span className="text-slate-400"> / {total}</span>
        <span className="ml-1">pts</span>
      </div>
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
          aria-label={`${pct}% complete`}
        />
      </div>
    </div>
  )
}

function Column({
  id,
  label,
  tone,
  stories,
}: {
  id: StoryStatus
  label: string
  tone: string
  stories: StoryRow[]
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const points = stories.reduce((acc, s) => acc + (s.storyPoints ?? 0), 0)

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        'flex min-h-[400px] flex-col rounded-lg border p-3 transition-colors',
        tone,
        isOver && 'ring-2 ring-brand-400 ring-offset-1',
      )}
      data-testid={`column-${id}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">{label}</h2>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{stories.length}</span>
          <span aria-hidden="true">·</span>
          <span>{points} pts</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {stories.map((s) => (
          <DraggableCard key={s.storyId} story={s} />
        ))}
        {stories.length === 0 && (
          <div className="rounded border border-dashed border-slate-200 bg-white/50 p-3 text-center text-xs text-slate-400">
            Drop here
          </div>
        )}
      </div>
    </div>
  )
}

function DraggableCard({ story }: { story: StoryRow }) {
  const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({
    id: story.storyId,
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={clsx(
        'cursor-grab rounded-md border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow',
        isDragging && 'opacity-60 shadow-lg',
      )}
      data-testid={`card-${story.storyId}`}
    >
      <div className="line-clamp-2 text-sm font-medium text-slate-900">{story.title}</div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <Link
          to={`/stories/${story.storyId}`}
          className="font-mono hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {story.storyId.slice(0, 8)}
        </Link>
        {story.storyPoints !== null && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium">
            {story.storyPoints} pts
          </span>
        )}
      </div>
    </div>
  )
}
