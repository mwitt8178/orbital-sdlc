/**
 * EpicCard — collapsible epic header with the per-epic story list inside.
 *
 * Renders a single epic + its stories. Reads the expansion state from the
 * backlog store. Story rows are pre-filtered by the parent (Backlog page).
 *
 * In the AI-pivot revision: the "+ Story" button is gone. Story creation
 * happens through the NLTicketCreator at the top of the page; the parser
 * suggests this epic when the user's prompt mentions it.
 */

import { useBacklogStore, isEpicExpanded } from '../../../store/backlog.js'
import { Badge } from '../../ui/Badge.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { StoryRow, type StoryRowData } from './StoryRow.js'

interface EpicCardProps {
  epicId: string
  title: string
  rationale: string
  status: 'draft' | 'active' | 'completed' | 'archived'
  stories: StoryRowData[]
}

export function EpicCard({ epicId, title, rationale, status, stories }: EpicCardProps) {
  const expanded = useBacklogStore((s) => isEpicExpanded(s, epicId))
  const toggleEpicExpanded = useBacklogStore((s) => s.toggleEpicExpanded)

  const completed = stories.filter(
    (s) => s.status === 'accepted' || s.status === 'done',
  ).length
  const completionPct = stories.length === 0 ? 0 : Math.round((completed / stories.length) * 100)

  const statusColor =
    status === 'active'
      ? 'emerald'
      : status === 'completed'
        ? 'violet'
        : status === 'archived'
          ? 'slate'
          : 'amber'

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white"
      data-testid={`epic-card-${epicId}`}
    >
      <header className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => toggleEpicExpanded(epicId)}
          aria-expanded={expanded}
          aria-controls={`epic-stories-${epicId}`}
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Chevron open={expanded} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-900">{title}</h3>
            <Badge color={statusColor}>{status}</Badge>
          </div>
          {rationale && <p className="mt-0.5 truncate text-xs text-slate-500">{rationale}</p>}
        </div>

        {/* Story count + completion */}
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>
            {stories.length} {stories.length === 1 ? 'story' : 'stories'}
          </span>
          {stories.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-16 overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full bg-emerald-500"
                  style={{ width: `${completionPct}%` }}
                />
              </span>
              <span className="font-mono">{completionPct}%</span>
            </span>
          )}
        </div>
      </header>

      {expanded && (
        <div id={`epic-stories-${epicId}`} className="border-t border-slate-100 px-3 py-2">
          {stories.length === 0 ? (
            <div className="py-2">
              <EmptyState
                title="No stories yet"
                description="Add a story by typing what you want in the prompt at the top of the page."
              />
            </div>
          ) : (
            <ul className="space-y-1" role="list">
              {stories.map((story) => (
                <li key={story.storyId}>
                  <StoryRow story={story} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
