/**
 * Dashboard — sprint dashboard.
 *
 * Hydrates the sprints store from `sprint.list` (no filter, so paused
 * sprints surface alongside active ones — the store picks the active
 * one first, paused as a fallback). The selected sprint drives the
 * title, the progress bar (counts from `orchestration.tasks.list`),
 * the day-of-sprint counter (from sprint.startedAt + wallClockTargetMs),
 * and the SprintControls (Pause/Resume/Complete).
 *
 * KPIs are computed client-side from the events store buffer + the
 * tasks query. The "Export audit" shortcut at top-right links to
 * `/audit?export=true`, which auto-opens the export modal.
 */

import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import { useSprintsStore, type Sprint } from '../store/sprints.js'
import { useEventsStore } from '../store/events.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { KpiCards } from '../components/features/dashboard/KpiCards.js'
import { SprintProgressBar } from '../components/features/dashboard/SprintProgressBar.js'
import { SprintControls } from '../components/features/dashboard/SprintControls.js'
import { AgentsInFlight } from '../components/features/dashboard/AgentsInFlight.js'
import { ActivityStream } from '../components/features/dashboard/ActivityStream.js'
import { NeedsAttention } from '../components/features/dashboard/NeedsAttention.js'
import { OnboardingChecklist } from '../components/features/dashboard/OnboardingChecklist.js'
// Round 7-08 — Operator-Attributed UI: Team panel
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../components/identity/OperatorBadge.js'
import { PresenceIndicator } from '../components/identity/PresenceIndicator.js'

// ---------------------------------------------------------------------------
// Team panel component (Round 7-08)
// ---------------------------------------------------------------------------

function TeamPanel() {
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 30_000 })
  const myIdQuery = trpc.team.myInstallId.useQuery(undefined, { staleTime: 60_000 })
  const myInstallId = myIdQuery.data?.install_id

  if (membersQuery.isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="h-7 w-7 animate-pulse rounded-full bg-slate-200" />
            <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    )
  }

  const members: TeamMember[] = (membersQuery.data ?? []).map((m) => ({
    install_id: m.install_id,
    display_name: m.display_name,
    role: m.role,
    last_seen_at: m.last_seen_at,
    color: m.color,
  }))

  if (members.length === 0) {
    return (
      <p className="text-xs text-slate-400 italic">No team members paired yet.</p>
    )
  }

  return (
    <ul className="space-y-2" aria-label="Team members">
      {members.map((member) => (
        <li key={member.install_id} className="flex items-center justify-between">
          <OperatorBadge
            installId={member.install_id}
            member={member}
            size="sm"
            showRole={member.install_id !== myInstallId}
            showPresence
          />
          {member.install_id === myInstallId && (
            <span className="text-[10px] text-slate-400">(you)</span>
          )}
        </li>
      ))}
    </ul>
  )
}

export default function Dashboard() {
  const setSprints = useSprintsStore((s) => s.setSprints)
  const activeSprint = useSprintsStore((s) => s.activeSprint)
  const events = useEventsStore((s) => s.events)

  // Pull all sprints (active + paused are both interesting for the dashboard).
  // The store picks active first, paused as a fallback.
  const sprintAllQuery = trpc.sprint.list.useQuery(undefined)
  const sprintQuery = sprintAllQuery
  const onboardingStatus = trpc.onboarding.status.useQuery()

  useEffect(() => {
    if (!sprintAllQuery.data) return
    const sprints = (sprintAllQuery.data as Array<Record<string, unknown>>).map(toSprint)
    setSprints(sprints)
    // sprintAllQuery.data is the only meaningful trigger here; setSprints is
    // a stable Zustand action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprintAllQuery.data])

  const tasksQuery = trpc.orchestration.tasks.list.useQuery(
    activeSprint?.id ? { sprint_id: activeSprint.id, limit: 200 } : (undefined as never),
    { enabled: !!activeSprint?.id },
  )

  const counts = useMemo(
    () => aggregateTaskCounts(tasksQuery.data?.items ?? []),
    [tasksQuery.data],
  )

  // Show the OnboardingChecklist when the user has just finished setup but
  // hasn't yet generated real activity. We detect this by looking for the
  // absence of any sprint at all.
  const totalSprints = (sprintAllQuery.data as Array<unknown> | undefined)?.length ?? 0
  const showChecklist =
    onboardingStatus.data?.setupCompletedAt !== null &&
    !sprintAllQuery.isLoading &&
    totalSprints === 0

  const checklistState = {
    hasMode: onboardingStatus.data?.mode !== null,
    hasFirstVision: false, // backlog detection inferred from epics — left false until vision lock event observed
    hasApprovedPlan: false,
    hasStartedSprint: !!activeSprint,
    hasReviewedAudit: events.length > 0,
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <span>Acme Product</span>
            <span aria-hidden="true">›</span>
            <span>Sprints</span>
          </div>
          {sprintQuery.isLoading ? (
            <h1 className="text-2xl font-bold text-slate-900">Sprint Dashboard</h1>
          ) : activeSprint ? (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-slate-900">{activeSprint.name}</h1>
              {activeSprint.status === 'paused' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
                    aria-hidden="true"
                  />
                  Paused
                </span>
              )}
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-slate-900">Sprint Dashboard</h1>
              <p className="mt-1 text-sm text-slate-500">
                No active sprint. Start one from the backlog to begin.
              </p>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeSprint && <SprintControls sprint={activeSprint} />}
          <Link
            to="/audit?export=true"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Export audit log"
          >
            <ExportIcon /> Export audit
          </Link>
        </div>
      </header>

      {sprintQuery.error && (
        <div className="mb-6">
          <ErrorMessage
            title="Could not load sprint"
            message={sprintQuery.error.message}
          />
        </div>
      )}

      {activeSprint ? (
        tasksQuery.isLoading ? (
          <div className="mb-6">
            <Skeleton rows={2} />
          </div>
        ) : (
          <SprintProgressBar
            done={counts.done}
            inReview={counts.inReview}
            blocked={counts.blocked}
            pending={counts.pending}
            startedAt={activeSprint.startedAt}
            wallClockTargetMs={activeSprint.wallClockTargetMs}
          />
        )
      ) : null}

      {showChecklist ? (
        <div className="mb-6">
          <OnboardingChecklist state={checklistState} />
        </div>
      ) : (
        <KpiCards events={events} tasks={tasksQuery.data?.items ?? []} />
      )}

      <div className="grid grid-cols-3 gap-5">
        <section className="col-span-2">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Agents in flight</h2>
          </header>
          <AgentsInFlight />
        </section>

        <section className="col-span-1 space-y-5">
          {/* Round 7-08 — Team presence panel */}
          <div>
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Team</h2>
            </header>
            <div className="rounded-lg border border-slate-100 bg-white p-3 shadow-sm">
              <TeamPanel />
            </div>
          </div>

          <div>
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Activity stream</h2>
            </header>
            <ActivityStream />
          </div>
        </section>
      </div>

      <section className="mt-8">
        <header className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Needs your attention</h2>
        </header>
        <NeedsAttention />
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSprint(row: Record<string, unknown>): Sprint {
  const wct = row['wallClockTargetMs'] ?? row['wall_clock_target_ms']
  return {
    id: String(row['sprintId'] ?? row['sprint_id'] ?? ''),
    name: String(row['name'] ?? ''),
    status: (row['status'] as Sprint['status']) ?? 'planning',
    startedAt: row['startedAt']
      ? row['startedAt'] instanceof Date
        ? (row['startedAt'] as Date).toISOString()
        : String(row['startedAt'])
      : null,
    completedAt: row['completedAt']
      ? row['completedAt'] instanceof Date
        ? (row['completedAt'] as Date).toISOString()
        : String(row['completedAt'])
      : null,
    wallClockTargetMs: typeof wct === 'number' ? wct : wct ? Number(wct) : null,
  }
}

function ExportIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function aggregateTaskCounts(tasks: Array<{ state: string }>): {
  done: number
  inReview: number
  blocked: number
  pending: number
} {
  let done = 0
  let inReview = 0
  let blocked = 0
  let pending = 0
  for (const t of tasks) {
    switch (t.state) {
      case 'done':
        done++
        break
      case 'in_review':
        inReview++
        break
      case 'blocked':
      case 'failed':
      case 'escalated':
        blocked++
        break
      default:
        pending++
    }
  }
  return { done, inReview, blocked, pending }
}
