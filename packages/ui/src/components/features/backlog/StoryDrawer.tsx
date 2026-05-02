/**
 * StoryDrawer — slide-in detail panel for a single story.
 *
 * Reads from useBacklogStore.drawerStoryId. When set, fetches the story via
 * backlog.stories.list (filtered to its epic) — there is no
 * backlog.stories.get with full ACs surfaced in the list response, so we
 * fetch the single story via the available list query.
 *
 * In the AI-pivot revision:
 *   - Status dropdown stays narrowed to orchestration-relevant next states
 *     (already done by `getValidNextStatuses`).
 *   - Sprint assignment becomes a click-to-assign dropdown (no DnD).
 *   - "Open in Monday →" link surfaces when monday_item_id is set so users
 *     can jump to the authoritative kanban for full project management.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { Badge } from '../../ui/Badge.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { useBacklogStore, type BacklogStoryStatus } from '../../../store/backlog.js'
import { useEventsStore } from '../../../store/events.js'
import { useToast } from '../../../services/use-toast.js'
import { useSprintsStore } from '../../../store/sprints.js'
import {
  getValidNextStatuses,
  statusBadgeColor,
  statusLabel,
  transitionRequiresLinkedArtifact,
} from '../../../utils/story-state-machine.js'

interface StoryRowLike {
  storyId?: unknown
  story_id?: unknown
  epicId?: unknown
  epic_id?: unknown
  title?: unknown
  description?: unknown
  status?: unknown
  storyPoints?: unknown
  story_points?: unknown
  defectId?: unknown
  defect_id?: unknown
  priority?: unknown
  mondayItemId?: unknown
  monday_item_id?: unknown
}

function pickStory(rows: unknown, storyId: string): StoryRowLike | null {
  if (!Array.isArray(rows)) return null
  return (
    (rows as StoryRowLike[]).find(
      (r) => String(r.storyId ?? r.story_id ?? '') === storyId,
    ) ?? null
  )
}

/**
 * Build a Monday deep-link from a board id and item id. Falls back to a
 * generic monday.com URL when no organisation subdomain is known. Exported
 * for unit testing.
 */
export function buildMondayLink(boardId: string | null, itemId: string): string | null {
  if (!boardId) return null
  if (!itemId) return null
  // Generic deep link form. Monday accepts the bare host without an org
  // subdomain and redirects to the user's authenticated org.
  return `https://monday.com/boards/${boardId}/pulses/${itemId}`
}

/** Coerce arbitrary input into the literal `monday_item_id` string when set. */
export function readMondayItemId(row: StoryRowLike | null): string | null {
  if (!row) return null
  const raw = row.mondayItemId ?? row.monday_item_id
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw
}

export function StoryDrawer() {
  const drawerStoryId = useBacklogStore((s) => s.drawerStoryId)
  const closeDrawer = useBacklogStore((s) => s.closeDrawer)
  const utils = trpc.useUtils()
  const toast = useToast()
  const sprints = useSprintsStore((s) => s.sprints)

  // Pull the active project for its Monday board id (used by the
  // "Open in Monday →" link).
  const projectQuery = trpc.projects.getActive.useQuery(undefined, { staleTime: 5 * 60_000 })
  const mondayBoardId =
    (projectQuery.data as { mondayBoardId?: string | null } | null | undefined)?.mondayBoardId ??
    null

  // Pull the full story list and pick the open one. List endpoint already in
  // cache from the parent page. We don't make a dedicated get-by-id call to
  // avoid duplicating cache state.
  const storiesQuery = trpc.backlog.stories.list.useQuery(undefined, {
    enabled: drawerStoryId !== null,
  })

  const storyRow = useMemo(
    () => (drawerStoryId ? pickStory(storiesQuery.data, drawerStoryId) : null),
    [storiesQuery.data, drawerStoryId],
  )

  // Local edit state, hydrated from the row when it loads.
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [storyPoints, setStoryPoints] = useState<number | null>(null)
  const [status, setStatus] = useState<BacklogStoryStatus>('backlog')
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)

  // Sprint assignment — currently committed sprint (if any), and the user's
  // selected target sprint to commit to.
  const [targetSprintId, setTargetSprintId] = useState<string>('')

  useEffect(() => {
    if (!storyRow || hydratedFor === drawerStoryId) return
    setTitle(String(storyRow.title ?? ''))
    setDescription(String(storyRow.description ?? ''))
    const sp = storyRow.storyPoints ?? storyRow.story_points
    setStoryPoints(sp === null || sp === undefined ? null : Number(sp))
    setStatus(String(storyRow.status ?? 'backlog') as BacklogStoryStatus)
    setTargetSprintId('')
    setHydratedFor(drawerStoryId)
  }, [storyRow, drawerStoryId, hydratedFor])

  // Keyboard close (Escape)
  useEffect(() => {
    if (!drawerStoryId) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [drawerStoryId, closeDrawer])

  // Recent activity for this story (events ring filtered).
  const events = useEventsStore((s) => s.events)
  const storyEvents = useMemo(() => {
    if (!drawerStoryId) return []
    return events
      .filter(
        (e) =>
          e.aggregate_id === drawerStoryId ||
          (e.payload as Record<string, unknown>)['story_id'] === drawerStoryId,
      )
      .slice(-10)
      .reverse()
  }, [events, drawerStoryId])

  const updateMutation = trpc.backlog.stories.update.useMutation({
    onSuccess: () => {
      toast.success('Story updated')
      void utils.backlog.stories.list.invalidate()
    },
    onError: (err) => {
      toast.error('Could not save story', { description: err.message })
    },
  })

  const groomMutation = trpc.backlog.groom.useMutation({
    onSuccess: () => {
      toast.success('Estimate updated')
      void utils.backlog.stories.list.invalidate()
    },
    onError: (err) => {
      toast.error('Could not update estimate', { description: err.message })
    },
  })

  const commitMutation = trpc.sprint.commit.useMutation({
    onSuccess: (_data, vars) => {
      const sprintName =
        sprints.find((s) => s.id === vars.sprint_id)?.name ?? 'sprint'
      toast.success(`Story added to ${sprintName}`)
      void utils.sprint.list.invalidate()
      void utils.sprint.get.invalidate({ sprint_id: vars.sprint_id })
      void utils.backlog.stories.list.invalidate()
    },
    onError: (err) => {
      toast.error('Could not assign to sprint', { description: err.message })
    },
  })

  if (!drawerStoryId) return null

  const onClose = () => closeDrawer()

  const handleSave = () => {
    if (!storyRow) return
    const original = {
      title: String(storyRow.title ?? ''),
      description: String(storyRow.description ?? ''),
      status: String(storyRow.status ?? 'backlog') as BacklogStoryStatus,
      storyPoints: (() => {
        const sp = storyRow.storyPoints ?? storyRow.story_points
        return sp === null || sp === undefined ? null : Number(sp)
      })(),
    }
    const patch: Parameters<typeof updateMutation.mutate>[0] = { story_id: drawerStoryId }
    if (title !== original.title) patch.title = title
    if (description !== original.description) patch.description = description
    if (status !== original.status) {
      // The update procedure's enum doesn't include 'cancelled' (admin-only path).
      // Guard here so the type-narrowed cast is safe.
      if (status !== 'cancelled') {
        patch.status = status
        patch.reason = `User updated status from ${original.status} to ${status} via drawer`
      }
    }
    if (Object.keys(patch).length > 1) {
      updateMutation.mutate(patch)
    }
    if (storyPoints !== null && storyPoints !== original.storyPoints) {
      groomMutation.mutate({
        story_id: drawerStoryId,
        story_points: storyPoints,
        rationale: 'Updated via drawer',
      })
    }
  }

  const handleAssignToSprint = () => {
    if (!targetSprintId || !drawerStoryId) return
    commitMutation.mutate({
      sprint_id: targetSprintId,
      selected_story_ids: [drawerStoryId],
      // Server recomputes capacity from the story list; we send 0 as a
      // best-effort placeholder so the schema is satisfied.
      capacity_used_points: 0,
      is_partial: true,
    })
  }

  const transitionRequirement = storyRow
    ? transitionRequiresLinkedArtifact(
        String(storyRow.status ?? 'backlog') as BacklogStoryStatus,
        status,
      )
    : null

  const mondayItemId = readMondayItemId(storyRow)
  const mondayLink = buildMondayLink(mondayBoardId, mondayItemId ?? '')

  // Round 5D: load tasks for this story so we can surface any open PR links.
  const tasksQuery = trpc.orchestration.tasks.list.useQuery(
    {},
    { enabled: drawerStoryId !== null, staleTime: 30_000 },
  )
  const storyTasks = (tasksQuery.data?.items ?? []).filter(
    (t: { storyId?: string | null; story_id?: string | null }) =>
      String(t.storyId ?? t.story_id ?? '') === (drawerStoryId ?? ''),
  )

  // Available sprint targets: planning / ready / active / paused.
  const assignableSprints = sprints.filter(
    (s) => s.status !== 'completed' && s.status !== 'completing',
  )

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-slate-900/30"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* Drawer */}
      <aside
        className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Story details"
        data-testid="story-drawer"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Story
            </span>
            {storyRow && (
              <Badge
                color={statusBadgeColor(
                  String(storyRow.status ?? 'backlog') as BacklogStoryStatus,
                )}
              >
                {statusLabel(String(storyRow.status ?? 'backlog') as BacklogStoryStatus)}
              </Badge>
            )}
            {mondayLink && (
              <a
                href={mondayLink}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="story-drawer-monday-link"
                className="ml-1 inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-800"
              >
                Open in Monday
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 17 17 7" />
                  <path d="M8 7h9v9" />
                </svg>
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {storiesQuery.isLoading && !storyRow ? (
            <Skeleton rows={5} />
          ) : !storyRow ? (
            <ErrorMessage
              title="Story not found"
              message="The story may have been deleted or filtered out."
              action={
                <Button size="sm" variant="secondary" onClick={onClose}>
                  Close
                </Button>
              }
            />
          ) : (
            <div className="space-y-5">
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-700"
                  htmlFor="drawer-title"
                >
                  Title
                </label>
                <Input
                  id="drawer-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-700"
                  htmlFor="drawer-desc"
                >
                  Description
                </label>
                <textarea
                  id="drawer-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="drawer-points"
                  >
                    Estimate
                  </label>
                  <select
                    id="drawer-points"
                    value={storyPoints ?? ''}
                    onChange={(e) =>
                      setStoryPoints(e.target.value === '' ? null : Number(e.target.value))
                    }
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Not estimated</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="5">5</option>
                    <option value="8">8</option>
                    <option value="13">13</option>
                  </select>
                </div>
                <div>
                  <label
                    className="mb-1 block text-xs font-medium text-slate-700"
                    htmlFor="drawer-status"
                  >
                    Status
                  </label>
                  <select
                    id="drawer-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BacklogStoryStatus)}
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {getValidNextStatuses(
                      String(storyRow.status ?? 'backlog') as BacklogStoryStatus,
                    ).map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Sprint assignment (click-to-assign, no DnD) */}
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-700"
                  htmlFor="drawer-sprint"
                >
                  Sprint
                </label>
                <div className="flex gap-2">
                  <select
                    id="drawer-sprint"
                    value={targetSprintId}
                    onChange={(e) => setTargetSprintId(e.target.value)}
                    className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Select a sprint…</option>
                    {assignableSprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.status})
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleAssignToSprint}
                    disabled={!targetSprintId || commitMutation.isPending}
                  >
                    {commitMutation.isPending ? 'Assigning…' : 'Assign'}
                  </Button>
                </div>
                {assignableSprints.length === 0 && (
                  <p className="mt-1 text-[11px] text-slate-400">
                    No sprints available. Create a sprint from the right rail.
                  </p>
                )}
              </div>

              {transitionRequirement && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  Transition requires a linked artifact of type:{' '}
                  <strong>{transitionRequirement.join(' or ')}</strong>. Add the link from the
                  parent context (e.g. UAT for uat_result) before saving.
                </div>
              )}

              {/* Round 5D: PR link cards */}
              {storyTasks.length > 0 && (
                <StoryPullRequests
                  tasks={storyTasks as Array<{ taskId?: string; task_id?: string; githubPrNumber?: number | null; githubPrUrl?: string | null; githubPrMergedAt?: string | null }>}
                />
              )}

              {/* AC list (read-only) */}
              <StoryAcceptanceCriteria storyId={drawerStoryId} />

              {/* Defect badge */}
              {storyRow.defectId || storyRow.defect_id ? (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  This story is linked to a defect (id:{' '}
                  <span className="font-mono">
                    {String((storyRow.defectId ?? storyRow.defect_id) as string)}
                  </span>
                  ).
                </div>
              ) : null}

              {/* Activity timeline */}
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Activity
                </h4>
                {storyEvents.length === 0 ? (
                  <p className="text-xs text-slate-400">No recent events for this story.</p>
                ) : (
                  <ul className="space-y-1.5" role="list">
                    {storyEvents.map((ev) => (
                      <li
                        key={ev.event_id}
                        className="flex items-center gap-2 text-xs text-slate-600"
                      >
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                        <span className="font-mono text-[10px] text-slate-400">
                          {new Date(ev.occurred_at).toLocaleTimeString()}
                        </span>
                        <span className="truncate">{ev.event_type}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={updateMutation.isPending || groomMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!storyRow || updateMutation.isPending || groomMutation.isPending}
          >
            {updateMutation.isPending || groomMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </footer>
      </aside>
    </>
  )
}

interface AcRow {
  acId?: unknown
  ac_id?: unknown
  ordinal?: unknown
  text?: unknown
}

// ---------------------------------------------------------------------------
// Round 5D: PR link cards
// ---------------------------------------------------------------------------

interface PRTaskRow {
  taskId?: string
  task_id?: string
  githubPrNumber?: number | null
  githubPrUrl?: string | null
  githubPrMergedAt?: string | null
}

function StoryPullRequests({ tasks: taskRows }: { tasks: PRTaskRow[] }) {
  const withPR = taskRows.filter((t) => t.githubPrNumber !== null && t.githubPrNumber !== undefined)
  if (withPR.length === 0) return null

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Pull requests
      </h4>
      <ul className="space-y-1.5" role="list">
        {withPR.map((t) => {
          const prNum = t.githubPrNumber!
          const url = t.githubPrUrl
          const merged = !!t.githubPrMergedAt
          const taskId = String(t.taskId ?? t.task_id ?? '')
          return (
            <li key={taskId}>
              <a
                href={url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="story-drawer-pr-link"
                className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs hover:bg-slate-100"
              >
                <span className="font-medium text-slate-800">PR #{prNum}</span>
                <span
                  className={
                    merged
                      ? 'rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700'
                      : 'rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700'
                  }
                >
                  {merged ? 'merged' : 'open'}
                </span>
                <span className="ml-auto text-[10px] text-slate-400">open in GitHub →</span>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StoryAcceptanceCriteria({ storyId }: { storyId: string }) {
  // backlog.stories.get includes ACs.
  const query = trpc.backlog.stories.get.useQuery({ story_id: storyId })

  if (query.isLoading) {
    return <Skeleton rows={2} />
  }
  if (query.error) {
    return (
      <p className="text-xs text-rose-600">
        Could not load acceptance criteria: {query.error.message}
      </p>
    )
  }
  const data = query.data as { acceptanceCriteria?: AcRow[] } | null | undefined
  const acs = data?.acceptanceCriteria ?? []

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Acceptance criteria ({acs.length})
      </h4>
      {acs.length === 0 ? (
        <p className="text-xs text-slate-400">No acceptance criteria defined.</p>
      ) : (
        <ol className="space-y-1.5" role="list">
          {acs.map((ac) => (
            <li
              key={String(ac.acId ?? ac.ac_id ?? '')}
              className="flex gap-2 rounded border border-slate-100 bg-slate-50 px-2 py-1.5 text-xs"
            >
              <span className="font-mono text-slate-400">{String(ac.ordinal ?? '')}.</span>
              <span className="text-slate-700">{String(ac.text ?? '')}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
