/**
 * Backlog — thin visualization layer on top of Monday's authoritative kanban.
 *
 * The page surfaces orchestration-specific metadata (vision linkage,
 * persona-of-record, AC verifier signals, defect lineage, sprint commitment)
 * that Monday can't show. For full project management — kanban filtering,
 * drag-and-drop, bulk operations — users go to Monday.
 *
 * Primary creation surface is the NLTicketCreator at the top of the epic
 * list: type "I want password reset via email", get a parsed proposal, edit,
 * confirm, done. Form-based creation survives only as a small "Manual"
 * fallback for epics (which are also auto-created when the vision is locked).
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ breadcrumb · title              "Manual ▾" menu      │
 *   │ scope hint copy                                      │
 *   │                                                      │
 *   │ ▸ Vision summary header                              │
 *   │                                                      │
 *   │ ┌──── ✨ NL ticket creator ────┐ ┌──── Sprints ─────┐│
 *   │ │ + proposal confirmation card │ │ SprintPanel       ││
 *   │ │ Search                       │ │                   ││
 *   │ │ EpicAccordion                │ │                   ││
 *   │ └──────────────────────────────┘ └───────────────────┘│
 *   └──────────────────────────────────────────────────────┘
 *
 * Live updates: useBacklogLiveSync watches the events ring (already fed by
 * the WebSocket) and invalidates the relevant tRPC queries on
 * StoryStatusChanged / StoryCreated / EpicCreated / SprintStarted etc.
 */

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../services/trpc.js'
import { useEventsStore } from '../store/events.js'
import { useBacklogStore } from '../store/backlog.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { Button } from '../components/ui/Button.js'
import { VisionSummaryHeader } from '../components/features/backlog/VisionSummaryHeader.js'
import { SearchInput } from '../components/features/backlog/SearchInput.js'
import { NLTicketCreator } from '../components/features/backlog/NLTicketCreator.js'
import {
  EpicAccordion,
  type EpicSummary,
} from '../components/features/backlog/EpicAccordion.js'
import { SprintPanel } from '../components/features/backlog/SprintPanel.js'
import { StoryDrawer } from '../components/features/backlog/StoryDrawer.js'
import { CreateEpicModal } from '../components/features/backlog/CreateEpicModal.js'
// Round 6 #1 — GitHub PR loop: PR badge in task rows
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
import { PRBadge } from '../components/features/pr/PRBadge.js'
export { PRBadge }
// Round 6 #9 — Inter-Agent Channel Collaboration: escalation banner
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
import { EscalationBanner } from '../components/features/channels/EscalationBanner.js'
// Round 7-08 — Operator-Attributed UI: operator filter + badge
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../components/identity/OperatorBadge.js'
import { OperatorFilter, type OperatorFilterValue } from '../components/identity/OperatorFilter.js'

interface RawEpicRow {
  epicId?: unknown
  epic_id?: unknown
  title?: unknown
  rationale?: unknown
  status?: unknown
}

function toEpicSummary(row: RawEpicRow): EpicSummary {
  return {
    epicId: String(row.epicId ?? row.epic_id ?? ''),
    title: String(row.title ?? 'Untitled'),
    rationale: String(row.rationale ?? ''),
    status: String(row.status ?? 'draft') as EpicSummary['status'],
  }
}

// ---------------------------------------------------------------------------
// Filter chips (Round 6 #3 — "Iterating" chip; Round 6 #2 — "Awaiting review")
// [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
// ---------------------------------------------------------------------------

type BacklogFilter = 'all' | 'iterating' | 'awaiting_review' | 'changes_requested'

function FilterChips({
  active,
  onChange,
}: {
  active: BacklogFilter
  onChange: (f: BacklogFilter) => void
}) {
  const chips: Array<{ id: BacklogFilter; label: string; title: string }> = [
    { id: 'all', label: 'All', title: 'Show all stories' },
    {
      id: 'iterating',
      label: 'Iterating',
      title: 'Stories with active defect iterations (state=ready, iteration_count>0)',
    },
    // Round 6 #2 — Code-Review Persona review filter chips
    // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
    {
      id: 'awaiting_review',
      label: 'Awaiting review',
      title: 'Stories whose PR is awaiting code review',
    },
    {
      id: 'changes_requested',
      label: 'Changes requested',
      title: 'Stories where the reviewer has requested changes',
    },
  ]
  return (
    <div className="flex gap-2" role="group" aria-label="Backlog filters">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          title={c.title}
          aria-pressed={active === c.id}
          onClick={() => onChange(c.id)}
          className={clsx(
            'rounded-full border px-3 py-0.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-violet-400',
            active === c.id
              ? 'border-violet-300 bg-violet-100 text-violet-800'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50',
          )}
          data-testid={`backlog-filter-${c.id}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

export default function Backlog() {
  const [activeFilter, setActiveFilter] = useState<BacklogFilter>('all')
  // Round 7-08 — Operator-Attributed UI: operator filter state
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const [operatorFilter, setOperatorFilter] = useState<OperatorFilterValue>('all')
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 30_000 })
  const myIdQuery = trpc.team.myInstallId.useQuery(undefined, { staleTime: 60_000 })
  const myInstallId = myIdQuery.data?.install_id ?? ''
  const teamMembers: TeamMember[] = (membersQuery.data ?? []).map((m) => ({
    install_id: m.install_id,
    display_name: m.display_name,
    role: m.role,
    last_seen_at: m.last_seen_at,
    color: m.color,
  }))

  const epicsQuery = trpc.backlog.epics.list.useQuery(undefined)
  // Round 6 #9 — get active sprint id for EscalationBanner
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  const sprintListQuery = trpc.sprint.list.useQuery(undefined, { staleTime: 30_000 })
  const activeSprint = (sprintListQuery.data as Array<{ sprint_id?: string; sprintId?: string; state?: string }> | undefined)
    ?.find((s) => s.state === 'active')
  const activeSprintId = activeSprint?.sprint_id ?? activeSprint?.sprintId ?? null

  // Wire WebSocket live updates: when a relevant event arrives, invalidate.
  useBacklogLiveSync()

  const epics: EpicSummary[] = (
    (epicsQuery.data as RawEpicRow[] | undefined) ?? []
  ).map(toEpicSummary)

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-6">
      <header className="mb-5 flex items-start justify-between">
        <div className="max-w-3xl">
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <span>Acme Product</span>
            <span aria-hidden="true">›</span>
            <span>Backlog</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            Backlog{' '}
            <span className="text-base font-normal text-slate-400">— Tickets visualized</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Lightweight view of stories, epics, and sprint commitments — with the
            orchestration metadata Monday can&apos;t show: vision linkage, persona-of-record,
            AC verifier signals. For full project management, use Monday →
          </p>
        </div>
        <ManualMenu />
      </header>

      <div className="mb-5">
        <VisionSummaryHeader />
      </div>

      {/* Round 6 #9 — EscalationBanner: shown when there are unresolved escalations */}
      {/* [Engineer-Sr · Sonnet · run-round6-09-channel-collab] */}
      {activeSprintId && (
        <div className="mb-4">
          <EscalationBanner sprintId={activeSprintId} />
        </div>
      )}

      {/* Round 6 #3/#2 — Backlog filter chips; Round 7-08 — Operator filter */}
      <div className="mb-4 space-y-2">
        <FilterChips active={activeFilter} onChange={setActiveFilter} />
        {/* Round 7-08 — Operator-Attributed UI: per-operator filter */}
        {/* [Engineer-Sr · Sonnet · run-round7-08-operator-attribution] */}
        {teamMembers.length > 1 && (
          <OperatorFilter
            value={operatorFilter}
            onChange={setOperatorFilter}
            members={teamMembers}
            myInstallId={myInstallId}
          />
        )}
        {activeFilter === 'iterating' && (
          <p className="mt-1 text-xs text-slate-500">
            Showing stories currently in a defect-driven iteration (task state=ready, iteration_count &gt; 0).
          </p>
        )}
        {activeFilter === 'awaiting_review' && (
          <p className="mt-1 text-xs text-slate-500">
            Showing stories whose PR is awaiting code review (code_review_state=awaiting_review).
          </p>
        )}
        {activeFilter === 'changes_requested' && (
          <p className="mt-1 text-xs text-slate-500">
            Showing stories where the reviewer has requested changes (code_review_state=changes_requested).
          </p>
        )}
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* Left: NL creator + search + epics */}
        <section className="col-span-12 space-y-4 lg:col-span-8">
          <NLTicketCreator
            epics={epics.map((e) => ({ epicId: e.epicId, title: e.title }))}
          />

          <SearchInput />

          {epicsQuery.isLoading ? (
            <Skeleton rows={6} />
          ) : epicsQuery.error ? (
            <ErrorMessage title="Could not load epics" message={epicsQuery.error.message} />
          ) : (
            <EpicAccordion epics={epics} />
          )}
        </section>

        {/* Right: sprints */}
        <section className="col-span-12 lg:col-span-4">
          <div className="lg:sticky lg:top-4">
            <SprintPanel />
          </div>
        </section>
      </div>

      {/* Slide-in story drawer (mounted at page root, controlled by store) */}
      <StoryDrawer />
    </div>
  )
}

// ---------------------------------------------------------------------------
// "Manual ▾" fallback dropdown (top-right) — Epic only.
// ---------------------------------------------------------------------------
//
// Bugs and stories are created via the NL prompt (NLTicketCreator). Epics are
// also typically auto-decomposed from a locked vision (see auto-decompose
// agent) — this menu is a power-user fallback when someone wants to create
// an epic by hand without typing it as a prompt.

function ManualMenu() {
  const open = useBacklogStore((s) => s.newMenuOpen)
  const setOpen = useBacklogStore((s) => s.setNewMenuOpen)
  const [showEpicModal, setShowEpicModal] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on click-outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOpen])

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="backlog-manual-menu-button"
      >
        Manual
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-1"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          role="menu"
          data-testid="backlog-manual-menu"
        >
          <ManualMenuItem
            label="Epic"
            description="Create an epic by hand"
            onClick={() => {
              setShowEpicModal(true)
              setOpen(false)
            }}
          />
        </div>
      )}

      {showEpicModal && <CreateEpicModal onClose={() => setShowEpicModal(false)} />}
    </div>
  )
}

function ManualMenuItem({
  label,
  description,
  onClick,
}: {
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
    >
      <div className="mt-0.5 text-brand-600" aria-hidden="true">
        +
      </div>
      <div>
        <div className="font-medium text-slate-900">{label}</div>
        <div className="text-xs text-slate-500">{description}</div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Live sync: when relevant events arrive via WebSocket, invalidate queries.
// ---------------------------------------------------------------------------

function useBacklogLiveSync(): void {
  const utils = trpc.useUtils()
  const events = useEventsStore((s) => s.events)
  const lastSeenRef = useRef<string | null>(null)

  useEffect(() => {
    if (events.length === 0) return
    const last = events[events.length - 1]
    if (!last) return
    if (last.event_id === lastSeenRef.current) return
    lastSeenRef.current = last.event_id

    const t = last.event_type
    if (
      t === 'StoryCreated' ||
      t === 'StoryStatusChanged' ||
      t === 'StoryRefined' ||
      t === 'StoryEstimated' ||
      t === 'BacklogReprioritized'
    ) {
      void utils.backlog.stories.list.invalidate()
    }
    if (t === 'EpicCreated') {
      void utils.backlog.epics.list.invalidate()
    }
    if (
      t === 'SprintCreated' ||
      t === 'SprintStarted' ||
      t === 'SprintCompleted' ||
      t === 'SprintPaused' ||
      t === 'SprintResumed' ||
      t === 'SprintCommitted'
    ) {
      void utils.sprint.list.invalidate()
    }
  }, [events, utils])
}
