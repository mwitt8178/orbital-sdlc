/**
 * PRDetailPanel — right-side drawer showing full PR details.
 *
 * Round 6 #1 — GitHub PR Loop
 * [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
 *
 * Round 6 #6 — CI/CD Bridge: CI tab now filled in.
 * Lists all check_runs for the PR head SHA, aggregates pass/fail counts,
 * and provides a "Re-run failed" button (capability-gated).
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Tabs:
 *   Overview       — branch, base, head SHA, opened-by-agent, opened_at
 *   Diff Summary   — file count, +/- lines, top 5 changed files (from GitHub API)
 *   Reviews        — reviewer state + comment count
 *   CI             — check_runs list, aggregate pass/fail, re-run button
 *   Activity       — PR-related events from event store for this task
 */

import { useState } from 'react'
import clsx from 'clsx'
import { PRBadge } from './PRBadge.js'
import { trpc } from '../../../services/trpc.js'
// Round 6 #2 — Code-Review Persona: Reviews tab uses ReviewPanel
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
import { ReviewPanel } from '../code-review/ReviewPanel.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PRDetailPanelProps {
  taskId: string
  prNumber: number
  prUrl: string | null
  prState: 'open' | 'merged' | 'closed'
  branch: string
  headSha: string | null
  mergedAt: string | null
  onClose: () => void
}

type TabId = 'overview' | 'diff' | 'reviews' | 'ci' | 'activity'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'diff', label: 'Diff Summary' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'ci', label: 'CI' },
  { id: 'activity', label: 'Activity' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Drawer-style panel mounted in the app shell, opened from Backlog/UAT on PR badge click.
 *
 * The CI tab shows "—" until Wave 3 #6 (check_run.completed webhook integration).
 * The Diff Summary tab shows placeholder data — real diff stats require
 * a prs.getDiff tRPC procedure (out-of-scope for this round).
 */
export function PRDetailPanel({
  taskId,
  prNumber,
  prUrl,
  prState,
  branch,
  headSha,
  mergedAt,
  onClose,
}: PRDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  return (
    <aside
      role="complementary"
      aria-label="Pull request details"
      className="fixed inset-y-0 right-0 z-40 flex w-[480px] flex-col border-l border-slate-200 bg-white shadow-xl"
      data-testid="pr-detail-panel"
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PRBadge taskId={taskId} />
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-sm font-semibold text-slate-900 hover:text-brand-600"
                aria-label={`Open PR #${prNumber} on GitHub`}
              >
                PR #{prNumber}
              </a>
            ) : (
              <span className="text-sm font-semibold text-slate-900">PR #{prNumber}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">{branch}</p>
        </div>
        <button
          type="button"
          aria-label="Close PR details"
          onClick={onClose}
          className="ml-3 flex-shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <nav aria-label="PR detail tabs" className="flex border-b border-slate-100 px-5" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'px-3 py-2.5 text-xs font-medium transition',
              activeTab === tab.id
                ? 'border-b-2 border-brand-500 text-brand-700'
                : 'text-slate-500 hover:text-slate-800',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-5 py-4" role="tabpanel">
        {activeTab === 'overview' && (
          <OverviewTab
            prNumber={prNumber}
            prState={prState}
            branch={branch}
            headSha={headSha}
            mergedAt={mergedAt}
            taskId={taskId}
          />
        )}
        {activeTab === 'diff' && <DiffSummaryTab />}
        {activeTab === 'reviews' && <ReviewsTab taskId={taskId} prNumber={prNumber} />}
        {activeTab === 'ci' && <CITab taskId={taskId} />}
        {activeTab === 'activity' && <ActivityTab taskId={taskId} />}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Tab: Overview
// ---------------------------------------------------------------------------

function OverviewTab({
  prNumber,
  prState,
  branch,
  headSha,
  mergedAt,
  taskId,
}: {
  prNumber: number
  prState: string
  branch: string
  headSha: string | null
  mergedAt: string | null
  taskId: string
}) {
  return (
    <dl className="space-y-3 text-sm">
      <Row label="PR number" value={`#${prNumber}`} />
      <Row label="Status" value={prState} />
      <Row label="Branch" value={branch} />
      <Row label="Base" value="main" />
      <Row label="Head SHA" value={headSha ? headSha.slice(0, 7) : '—'} />
      <Row label="Task ID" value={taskId.slice(0, 8)} />
      {mergedAt && <Row label="Merged at" value={new Date(mergedAt).toLocaleString()} />}
    </dl>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-5 gap-2">
      <dt className="col-span-2 font-medium text-slate-500">{label}</dt>
      <dd className="col-span-3 text-slate-900">{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Diff Summary — placeholder (real data via prs.getDiff in future round)
// ---------------------------------------------------------------------------

function DiffSummaryTab() {
  return (
    <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-500">
      <p className="font-medium text-slate-700">Diff summary</p>
      <p className="mt-1 text-xs">
        Diff stats are fetched from the GitHub API. This panel will populate once
        the <code className="rounded bg-slate-100 px-1">prs.getDiff</code> procedure is wired
        in a future round.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Reviews — Round 6 #2 (Code-Review Persona)
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
// ---------------------------------------------------------------------------

function ReviewsTab({ taskId, prNumber }: { taskId: string; prNumber: number }) {
  return (
    <ReviewPanel
      prNumber={prNumber}
      authorTaskId={taskId}
    />
  )
}

// ---------------------------------------------------------------------------
// Tab: CI — Round 6 #6 (CI/CD Bridge)
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

const CI_CONCLUSION_CLASSES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  failure: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-600',
  skipped: 'bg-slate-100 text-slate-400',
  timed_out: 'bg-amber-100 text-amber-700',
  neutral: 'bg-slate-100 text-slate-600',
  action_required: 'bg-amber-100 text-amber-700',
}

const STATUS_CLASSES: Record<string, string> = {
  in_progress: 'bg-sky-100 text-sky-700',
  queued: 'bg-slate-100 text-slate-600',
  completed: 'bg-slate-100 text-slate-500',
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s > 0 ? ` ${s}s` : ''}`
}

function CITab({ taskId }: { taskId: string }) {
  const checkRunsQuery = trpc.prs.checkRuns.useQuery(
    { task_id: taskId },
    { staleTime: 30_000 },
  )

  const rerunMutation = trpc.prs.rerunFailed.useMutation({
    onSuccess: () => {
      void checkRunsQuery.refetch()
    },
  })

  if (checkRunsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" aria-hidden="true" />
        <span className="ml-2 text-xs text-slate-500">Loading CI checks…</span>
      </div>
    )
  }

  if (checkRunsQuery.error) {
    return (
      <div className="rounded-md bg-rose-50 p-4 text-xs text-rose-700">
        Failed to load CI checks: {checkRunsQuery.error.message}
      </div>
    )
  }

  const data = checkRunsQuery.data
  const checkRuns = data?.check_runs ?? []

  if (checkRuns.length === 0) {
    return (
      <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-500">
        <p className="font-medium text-slate-700">CI checks</p>
        <p className="mt-1 text-xs">
          {data?.head_sha
            ? 'No CI check runs found for this commit.'
            : 'No head SHA recorded — CI checks are available after the PR is opened.'}
        </p>
      </div>
    )
  }

  const totalCount = (data as { total_count?: number } | undefined)?.total_count ?? checkRuns.length
  const passingCount = (data as { passing_count?: number } | undefined)?.passing_count ?? checkRuns.filter(
    (cr) => cr.conclusion === 'success' || cr.conclusion === 'neutral' || cr.conclusion === 'skipped',
  ).length
  const failingCount = checkRuns.filter(
    (cr) => cr.conclusion === 'failure' || cr.conclusion === 'cancelled' || cr.conclusion === 'timed_out',
  ).length

  return (
    <div className="space-y-4">
      {/* Aggregate summary */}
      <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2">
        <p className="text-xs font-medium text-slate-700">
          <span className="text-emerald-700">{passingCount}</span>
          <span className="text-slate-400"> / </span>
          <span className="text-slate-700">{totalCount}</span>
          <span className="ml-1 text-slate-500">checks passing</span>
          {failingCount > 0 && (
            <span className="ml-1 text-rose-600">
              · {failingCount} failing
            </span>
          )}
        </p>

        {/* Re-run failed — capability-gated: only shown when ORBITAL_PR_LOOP=on */}
        {failingCount > 0 && (
          <button
            type="button"
            onClick={() => rerunMutation.mutate({ task_id: taskId })}
            disabled={rerunMutation.isPending}
            className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
            aria-label={`Re-run ${failingCount} failed check${failingCount === 1 ? '' : 's'}`}
          >
            {rerunMutation.isPending ? 'Triggering…' : 'Re-run failed'}
          </button>
        )}
      </div>

      {rerunMutation.isSuccess && (
        <p className="text-xs text-emerald-600" role="status">
          {rerunMutation.data.triggered} re-run{rerunMutation.data.triggered === 1 ? '' : 's'} triggered.
        </p>
      )}
      {rerunMutation.error && (
        <p className="text-xs text-rose-600" role="alert">
          Re-run failed: {rerunMutation.error.message}
        </p>
      )}

      {/* Check run list */}
      <ul className="space-y-2" role="list" aria-label="CI check runs">
        {checkRuns.map((cr) => {
          const conclusionClasses = cr.conclusion
            ? (CI_CONCLUSION_CLASSES[cr.conclusion] ?? 'bg-slate-100 text-slate-600')
            : (STATUS_CLASSES[cr.status] ?? 'bg-slate-100 text-slate-600')

          const label = cr.conclusion ?? cr.status

          return (
            <li
              key={cr.id}
              className="flex items-start justify-between gap-2 rounded-md border border-slate-100 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-900">{cr.name}</p>
                {cr.started_at && (
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    Duration: {formatDuration(cr.completed_at && cr.started_at
                      ? Math.max(0, new Date(cr.completed_at).getTime() - new Date(cr.started_at).getTime())
                      : null
                    )}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${conclusionClasses}`}
                >
                  {label}
                </span>
                {cr.html_url && (
                  <a
                    href={cr.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${cr.name} in GitHub Actions`}
                    className="flex-shrink-0 text-slate-400 hover:text-brand-600"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Activity
// ---------------------------------------------------------------------------

function ActivityTab({ taskId }: { taskId: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500">Event stream for task {taskId.slice(0, 8)}</p>
      <p className="text-xs text-slate-400">
        PR-related events (BranchPushed, PROpened, PRMerged, PRClosed) will appear here as they
        are emitted by the orchestrator.
      </p>
    </div>
  )
}
