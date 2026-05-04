/**
 * UAT page — story selector → AC checklist → submit/accept.
 *
 * Strategy:
 *   1. Fetch all stories via backlog.stories.list (without status filter).
 *   2. Show stories in 'in_review' or 'done' state — those are UAT-eligible.
 *   3. When a story is selected, list sessions; if none exist, offer to start
 *      a new session via uat.session.start. Otherwise pick the most recent
 *      and render the AC checklist.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import { useUATStore } from '../store/uat.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { Button } from '../components/ui/Button.js'
import { ACChecklist } from '../components/features/uat/ACChecklist.js'
import { DefectList } from '../components/features/uat/DefectList.js'
// Round 6 #1 — GitHub PR loop: PR summary strip above checklist
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
import { PRSummaryStrip } from '../components/features/pr/PRSummaryStrip.js'
import { PRDetailPanel } from '../components/features/pr/PRDetailPanel.js'
// Round 6 #3 — Iterate-on-Defect Loop: DefectReporter modal + DefectTimeline
// [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
import { DefectReporter } from '../components/features/uat/DefectReporter.js'
import { DefectTimeline } from '../components/features/uat/DefectTimeline.js'
// Round 6 #2 — Code-Review Persona: review summary above ACChecklist
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
import { CodeReviewSummary } from '../components/features/code-review/CodeReviewSummary.js'
// Round 6 #9 — Inter-Agent Channel Collaboration: escalation banner
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
import { EscalationBanner } from '../components/features/channels/EscalationBanner.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

// ---------------------------------------------------------------------------
// Round 6 #9 — Escalation banner row (fetches active sprint then renders)
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
// ---------------------------------------------------------------------------

function UATEscalationBannerRow() {
  const sprintListQuery = trpc.sprint.list.useQuery(undefined, { staleTime: 30_000 })
  const activeSprint = (sprintListQuery.data as Array<{ sprint_id?: string; sprintId?: string; state?: string }> | undefined)
    ?.find((s) => s.state === 'active')
  const activeSprintId = activeSprint?.sprint_id ?? activeSprint?.sprintId ?? null
  if (!activeSprintId) return null
  return (
    <div className="mb-5">
      <EscalationBanner sprintId={activeSprintId} />
    </div>
  )
}

// PRDetailPanel drawer state — local to this page
interface PRPanelState {
  taskId: string
  prNumber: number
  prUrl: string | null
  prState: 'open' | 'merged' | 'closed'
  branch: string
  headSha: string | null
  mergedAt: string | null
}

export default function UAT() {
  const selectedTicketId = useUATStore((s) => s.selectedTicketId)
  const selectedSessionId = useUATStore((s) => s.selectedSessionId)
  const setSelectedTicket = useUATStore((s) => s.setSelectedTicket)
  const setSelectedSession = useUATStore((s) => s.setSelectedSession)
  const utils = trpc.useUtils()
  const [prPanel, setPrPanel] = useState<PRPanelState | null>(null)

  // Round 6 #3 — DefectReporter modal state
  // [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
  const [defectReporterState, setDefectReporterState] = useState<{
    taskId: string
    acId: string
    acText: string
    iterationCount: number
  } | null>(null)

  const storiesQuery = trpc.backlog.stories.list.useQuery({ status: 'in_review' })
  const acceptedStoriesQuery = trpc.backlog.stories.list.useQuery({ status: 'done' })

  const sessionsQuery = trpc.uat.session.list.useQuery(
    selectedTicketId
      ? { ticket_id: selectedTicketId, include_ac_results: false }
      : (undefined as never),
    { enabled: !!selectedTicketId },
  )

  const startMutation = trpc.uat.session.start.useMutation({
    onSuccess: (data) => {
      setSelectedSession(data.session.uat_session_id)
      if (selectedTicketId) {
        void utils.uat.session.list.invalidate({
          ticket_id: selectedTicketId,
          include_ac_results: false,
        })
      }
    },
  })

  const eligibleStories = useMemo(() => {
    const inReview = ((storiesQuery.data ?? []) as Array<Record<string, unknown>>).map(toStoryRow)
    const accepted = ((acceptedStoriesQuery.data ?? []) as Array<Record<string, unknown>>).map(
      toStoryRow,
    )
    return [...inReview, ...accepted]
  }, [storiesQuery.data, acceptedStoriesQuery.data])

  // Auto-select latest session when sessions list arrives.
  useEffect(() => {
    if (!sessionsQuery.data) return
    const sessions = sessionsQuery.data.sessions
    if (sessions.length > 0 && !selectedSessionId) {
      setSelectedSession(sessions[0]!.uat_session_id)
    }
    // setSelectedSession is a stable Zustand action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQuery.data, selectedSessionId])

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <ProjectBreadcrumb />
            <span aria-hidden="true">›</span>
            <span>UAT</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">User Acceptance Testing</h1>
          <p className="mt-1 text-sm text-slate-500">
            Review stories that have passed verification and are ready for your acceptance.
          </p>
        </div>
      </header>

      {/* Round 6 #9 — EscalationBanner: shown when there are unresolved escalations */}
      {/* [Engineer-Sr · Sonnet · run-round6-09-channel-collab] */}
      <UATEscalationBannerRow />

      <div className="grid grid-cols-3 gap-5">
        {/* Story picker + AC checklist */}
        <div className="col-span-2 rounded-lg border border-slate-200 bg-white p-5">
          <div className="mb-4">
            <label
              className="mb-1 block text-xs font-medium text-slate-700"
              htmlFor="uat-story"
            >
              Story under review
            </label>
            <select
              id="uat-story"
              value={selectedTicketId ?? ''}
              onChange={(e) => {
                setSelectedTicket(e.target.value || null)
                setSelectedSession(null)
              }}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Select a story…</option>
              {eligibleStories.map((s) => (
                <option key={s.storyId} value={s.storyId}>
                  {s.storyKey ? `${s.storyKey} · ` : ''}
                  {s.title} ({s.status})
                </option>
              ))}
            </select>
            {storiesQuery.error && (
              <p className="mt-1 text-xs text-rose-600">{storiesQuery.error.message}</p>
            )}
          </div>

          {!selectedTicketId ? (
            eligibleStories.length === 0 ? (
              <UATEmptyCta />
            ) : (
              <EmptyState
                title="No story selected"
                description="Choose a story above to begin UAT."
              />
            )
          ) : sessionsQuery.isLoading ? (
            <Skeleton rows={4} />
          ) : sessionsQuery.error ? (
            <ErrorMessage
              title="Could not load sessions"
              message={sessionsQuery.error.message}
            />
          ) : !selectedSessionId ? (
            <div className="rounded-md bg-slate-50 p-4">
              <p className="text-sm text-slate-700">
                No UAT session yet. Start one to mark acceptance criteria.
              </p>
              <Button
                className="mt-3"
                onClick={() =>
                  startMutation.mutate({
                    ticket_id: selectedTicketId,
                    triggered_by_event_id: crypto.randomUUID(),
                    build_ref: 'local',
                    resume_existing: true,
                    justification: 'User started UAT session via UI',
                  })
                }
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? 'Starting…' : 'Start UAT session'}
              </Button>
              {startMutation.error && (
                <p className="mt-2 text-xs text-rose-600">{startMutation.error.message}</p>
              )}
            </div>
          ) : (
            <>
              {/* Round 6 #1 — PR summary above checklist */}
              {selectedTicketId && (
                <PRSummaryStrip taskId={selectedTicketId} />
              )}
              {/* Round 6 #2 — Code review summary above ACChecklist */}
              {selectedTicketId && (
                <CodeReviewSummary taskId={selectedTicketId} />
              )}
              <ACChecklist
                sessionId={selectedSessionId}
                taskId={selectedTicketId ?? undefined}
                onReportDefect={(acId, acText) => {
                  if (selectedTicketId) {
                    setDefectReporterState({
                      taskId: selectedTicketId,
                      acId,
                      acText,
                      iterationCount: 0,
                    })
                  }
                }}
              />

              {/* Round 6 #3 — DefectTimeline below checklist */}
              {selectedTicketId && (
                <div className="mt-5">
                  <h3 className="mb-2 text-sm font-semibold text-slate-800">
                    Defect Iteration History
                  </h3>
                  <DefectTimeline taskId={selectedTicketId} />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right rail */}
        <aside className="col-span-1 space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Defects</h2>
            {selectedTicketId ? (
              <DefectList storyId={selectedTicketId} />
            ) : (
              <p className="py-4 text-center text-xs text-slate-400">
                Select a story to see defects.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Round 6 #3 — DefectReporter modal */}
      {defectReporterState && (
        <DefectReporter
          taskId={defectReporterState.taskId}
          acId={defectReporterState.acId}
          acText={defectReporterState.acText}
          iterationCount={defectReporterState.iterationCount}
          onClose={() => {
            setDefectReporterState(null)
            void utils.uat.defects.history.invalidate()
          }}
        />
      )}

      {/* Round 6 #1 — PR detail panel drawer */}
      {prPanel && (
        <PRDetailPanel
          taskId={prPanel.taskId}
          prNumber={prPanel.prNumber}
          prUrl={prPanel.prUrl}
          prState={prPanel.prState}
          branch={prPanel.branch}
          headSha={prPanel.headSha}
          mergedAt={prPanel.mergedAt}
          onClose={() => setPrPanel(null)}
        />
      )}
    </div>
  )
}

function UATEmptyCta() {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
      <h3 className="text-sm font-semibold text-slate-900">Nothing to review yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
        UAT runs after a sprint completes. Try a sprint in demo mode to see how it feels.
      </p>
      <Link
        to="/welcome"
        className="mt-3 inline-flex items-center text-xs font-medium text-brand-600 hover:text-brand-700"
      >
        Try demo mode →
      </Link>
    </div>
  )
}

interface StoryRow {
  storyId: string
  storyKey: string | null
  title: string
  status: string
}

function toStoryRow(row: Record<string, unknown>): StoryRow {
  return {
    storyId: String(row['storyId'] ?? row['story_id'] ?? ''),
    storyKey: (row['storyKey'] as string | null | undefined) ?? null,
    title: String(row['title'] ?? 'Untitled'),
    status: String(row['status'] ?? ''),
  }
}
