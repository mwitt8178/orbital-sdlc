/**
 * StoryRow — single story line under an EpicCard.
 *
 * Click → opens drawer. The status badge, story-points pill, AC count, defect
 * dot, and current-sprint chip (when assigned) are all displayed inline.
 *
 * In the AI-pivot revision: drag-and-drop is gone (Monday is the
 * authoritative kanban). Bulk-select checkboxes are gone (Monday handles
 * bulk operations). Sprint assignment is via click-to-assign in
 * StoryDrawer / SprintCard, not drag.
 */

import clsx from 'clsx'
import { Badge } from '../../ui/Badge.js'
import { useBacklogStore, type BacklogStoryStatus } from '../../../store/backlog.js'
import { statusBadgeColor, statusLabel } from '../../../utils/story-state-machine.js'

export interface StoryRowData {
  storyId: string
  title: string
  status: BacklogStoryStatus
  storyPoints: number | null
  priority: number
  acCount: number
  defectId: string | null
  /** Optional: sprint name + id if the story is currently committed to a sprint. */
  currentSprint?: { id: string; name: string } | null
}

interface StoryRowProps {
  story: StoryRowData
}

export function StoryRow({ story }: StoryRowProps) {
  const openDrawer = useBacklogStore((s) => s.openDrawer)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openDrawer(story.storyId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openDrawer(story.storyId)
        }
      }}
      data-testid={`story-row-${story.storyId}`}
      className={clsx(
        'group flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-2 transition hover:border-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
      )}
      aria-label={`Story: ${story.title}, status ${story.status}`}
    >
      {/* Defect-or-not visual cue */}
      <span
        className={clsx(
          'inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
          story.defectId ? 'bg-rose-500' : 'bg-slate-300',
        )}
        aria-hidden="true"
        title={story.defectId ? 'Defect-tagged story' : undefined}
      />

      <span className="flex-1 truncate text-sm text-slate-900">{story.title}</span>

      {/* AC count */}
      {story.acCount > 0 && (
        <span className="text-[11px] text-slate-500">
          {story.acCount} AC{story.acCount === 1 ? '' : 's'}
        </span>
      )}

      {/* Story points */}
      {story.storyPoints !== null && (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono font-medium text-slate-700">
          {story.storyPoints} pt{story.storyPoints === 1 ? '' : 's'}
        </span>
      )}

      {/* Status badge */}
      <Badge color={statusBadgeColor(story.status)}>{statusLabel(story.status)}</Badge>

      {/* Sprint chip */}
      {story.currentSprint && <Badge color="indigo">{story.currentSprint.name}</Badge>}
    </div>
  )
}
