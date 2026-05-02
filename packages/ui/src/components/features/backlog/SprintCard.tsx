/**
 * SprintCard — single sprint summary in the right rail.
 *
 * In the AI-pivot revision: drop-target removed. Sprint assignment now
 * happens from StoryDrawer's "Sprint" dropdown (click-to-assign) rather
 * than drag-and-drop, since Monday is the authoritative kanban surface.
 *
 * The card still shows status, story counts, capacity bar (active sprints),
 * and a Start button (planning sprints).
 */

import { useMemo } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { useToast } from '../../../services/use-toast.js'
import type { Sprint } from '../../../store/sprints.js'

interface SprintCardProps {
  sprint: Sprint
}

export function SprintCard({ sprint }: SprintCardProps) {
  const utils = trpc.useUtils()
  const toast = useToast()

  // Pull the full sprint detail (includes commitment + selected_story_ids).
  const detailQuery = trpc.sprint.get.useQuery(
    { sprint_id: sprint.id },
    { enabled: !!sprint.id, staleTime: 30_000 },
  )

  const detail = detailQuery.data as
    | {
        sprint?: { storyPointCapacity?: number; story_point_capacity?: number }
        commitment?: {
          selectedStoryIds?: string[]
          selected_story_ids?: string[]
          capacityUsedPoints?: number
          capacity_used_points?: number
        } | null
      }
    | undefined

  const committedStoryIds: string[] = useMemo(() => {
    const c = detail?.commitment
    if (!c) return []
    return c.selectedStoryIds ?? c.selected_story_ids ?? []
  }, [detail])

  const capacity =
    detail?.sprint?.storyPointCapacity ?? detail?.sprint?.story_point_capacity ?? 0
  const used =
    detail?.commitment?.capacityUsedPoints ?? detail?.commitment?.capacity_used_points ?? 0

  const startMutation = trpc.sprint.start.useMutation({
    onSuccess: () => {
      toast.success(`Started ${sprint.name}`)
      void utils.sprint.list.invalidate()
      void utils.sprint.get.invalidate({ sprint_id: sprint.id })
    },
    onError: (err) => toast.error('Could not start sprint', { description: err.message }),
  })

  const statusColor =
    sprint.status === 'active'
      ? 'emerald'
      : sprint.status === 'paused'
        ? 'amber'
        : sprint.status === 'completed'
          ? 'violet'
          : sprint.status === 'planning'
            ? 'slate'
            : 'blue'

  return (
    <div
      data-testid={`sprint-card-${sprint.id}`}
      className="rounded-lg border border-slate-200 bg-white p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{sprint.name}</p>
        </div>
        <Badge color={statusColor}>{sprint.status}</Badge>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
        <span>{committedStoryIds.length} stories</span>
        {capacity > 0 && (
          <span className="font-mono">
            {used}/{capacity} pts
          </span>
        )}
      </div>

      {capacity > 0 && (
        <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={
              used > capacity
                ? 'h-full rounded-full bg-rose-500 transition-all'
                : 'h-full rounded-full bg-emerald-500 transition-all'
            }
            style={{ width: `${Math.min(100, capacity === 0 ? 0 : (used / capacity) * 100)}%` }}
          />
        </div>
      )}

      {sprint.status === 'planning' && (
        <div className="space-y-1">
          <Button
            size="sm"
            className="w-full"
            onClick={() => startMutation.mutate({ sprint_id: sprint.id })}
            disabled={startMutation.isPending || committedStoryIds.length === 0}
          >
            {startMutation.isPending ? 'Starting…' : 'Start sprint'}
          </Button>
          {committedStoryIds.length === 0 && (
            <p className="text-[10px] text-slate-400">
              Assign stories from the story drawer, then start.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
