/**
 * EpicAccordion — owns the list-of-epics section in the left column.
 *
 * Pulls epics + stories from tRPC, applies the search-text filter from
 * useBacklogStore (the AI-pivot stripped status / sprint / epic filter chips
 * — Monday is the authoritative kanban surface), and renders an EpicCard per
 * epic. Empty states:
 *   - Loading: skeleton
 *   - Error: ErrorMessage
 *   - No epics yet (vision locked): inline "epics auto-create when you lock
 *     the vision; otherwise type a request above" CTA. The "+ Manual" path
 *     in Backlog.tsx still allows creating an epic by hand.
 */

import { useMemo } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useBacklogStore, type BacklogStoryStatus } from '../../../store/backlog.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { EpicCard } from './EpicCard.js'
import type { StoryRowData } from './StoryRow.js'

export interface EpicSummary {
  epicId: string
  title: string
  rationale: string
  status: 'draft' | 'active' | 'completed' | 'archived'
}

interface EpicAccordionProps {
  epics: EpicSummary[]
}

interface RawStoryRow {
  storyId?: unknown
  story_id?: unknown
  epicId?: unknown
  epic_id?: unknown
  title?: unknown
  status?: unknown
  storyPoints?: unknown
  story_points?: unknown
  priority?: unknown
  defectId?: unknown
  defect_id?: unknown
}

function toStoryRow(row: RawStoryRow): {
  storyId: string
  epicId: string
  title: string
  status: BacklogStoryStatus
  storyPoints: number | null
  priority: number
  defectId: string | null
} {
  const points = row.storyPoints ?? row.story_points
  return {
    storyId: String(row.storyId ?? row.story_id ?? ''),
    epicId: String(row.epicId ?? row.epic_id ?? ''),
    title: String(row.title ?? 'Untitled'),
    status: String(row.status ?? 'backlog') as BacklogStoryStatus,
    storyPoints: points === null || points === undefined ? null : Number(points),
    priority: Number(row.priority ?? 0),
    defectId: (row.defectId ?? row.defect_id ?? null) as string | null,
  }
}

export function EpicAccordion({ epics }: EpicAccordionProps) {
  const search = useBacklogStore((s) => s.filters.search)

  // Fetch all stories — server-side filtering only supports status/epic, but
  // we want to apply a simple text filter client-side. Bulk fetch is fine
  // for the local-first single-tenant scope.
  const storiesQuery = trpc.backlog.stories.list.useQuery(undefined)

  // Group stories by epicId after applying the search filter.
  const groupedStories = useMemo(() => {
    const groups = new Map<string, StoryRowData[]>()
    if (!storiesQuery.data) return groups

    const allStories = (storiesQuery.data as RawStoryRow[]).map(toStoryRow)

    const q = search.trim().toLowerCase()
    const matches = allStories.filter((s) => {
      if (q.length === 0) return true
      return s.title.toLowerCase().includes(q)
    })

    for (const s of matches) {
      const list = groups.get(s.epicId) ?? []
      list.push({
        storyId: s.storyId,
        title: s.title,
        status: s.status,
        storyPoints: s.storyPoints,
        priority: s.priority,
        acCount: 0,
        defectId: s.defectId,
        currentSprint: null,
      })
      groups.set(s.epicId, list)
    }

    // Sort within each group by priority asc.
    for (const list of groups.values()) {
      list.sort((a, b) => a.priority - b.priority)
    }
    return groups
  }, [storiesQuery.data, search])

  if (storiesQuery.isLoading) {
    return (
      <div className="space-y-3" data-testid="epic-accordion-loading">
        <Skeleton rows={5} />
      </div>
    )
  }

  if (storiesQuery.error) {
    return (
      <ErrorMessage
        title="Could not load stories"
        message={storiesQuery.error.message}
      />
    )
  }

  if (epics.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center"
        data-testid="epic-accordion-empty"
      >
        <p className="mb-1 text-sm font-semibold text-slate-900">No epics yet</p>
        <p className="mx-auto mb-2 max-w-md text-xs text-slate-500">
          Epics auto-create when you lock the vision. Otherwise, type a request in the prompt
          above and Orbital will draft an epic for you. Power users can also create one from
          the Manual menu.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="epic-accordion">
      {epics.map((epic) => (
        <EpicCard
          key={epic.epicId}
          epicId={epic.epicId}
          title={epic.title}
          rationale={epic.rationale}
          status={epic.status}
          stories={groupedStories.get(epic.epicId) ?? []}
        />
      ))}
    </div>
  )
}
