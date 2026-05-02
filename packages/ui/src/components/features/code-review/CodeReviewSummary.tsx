/**
 * CodeReviewSummary — compact one-line review summary for the UAT page.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Shown above ACChecklist in UAT page when a code review exists.
 *
 * Example: "Code review: APPROVED by reviewer-sonnet at 14:32"
 * Example: "Code review: CHANGES REQUESTED by reviewer at 09:15"
 *
 * Per architecture.md: "Above ACChecklist, show: 'Code review: APPROVED
 * by reviewer-sonnet at HH:MM' with link to ReviewPanel"
 */

import { trpc } from '../../../services/trpc.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeReviewSummaryProps {
  /** Task ID to look up PR number from. */
  taskId: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Fetches the latest code review for the task's PR and renders a compact
 * one-line summary above the ACChecklist.
 * Renders nothing when there are no reviews yet.
 */
export function CodeReviewSummary({ taskId }: CodeReviewSummaryProps) {
  // Step 1: Get the PR for this task
  const prQuery = trpc.prs.byTask.useQuery(
    { task_id: taskId },
    { staleTime: 30_000, refetchOnWindowFocus: false },
  )

  const prNumber = prQuery.data?.pr?.pr_number ?? null

  // Step 2: Get reviews for this PR (only when we have a PR number)
  const reviewsQuery = trpc.code_reviews.byPR.useQuery(
    { pr_number: prNumber ?? 0 },
    {
      enabled: prNumber !== null && prNumber > 0,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  )

  if (prQuery.isLoading || reviewsQuery.isLoading) {
    return null
  }

  if (!prNumber) {
    return null
  }

  const reviews = reviewsQuery.data?.reviews ?? []
  if (reviews.length === 0) {
    return null
  }

  // Show the most recent review
  const latest = reviews[reviews.length - 1]!

  const stateText =
    latest.state === 'APPROVED'
      ? 'APPROVED'
      : latest.state === 'CHANGES_REQUESTED'
        ? 'CHANGES REQUESTED'
        : 'COMMENTED'

  const timeText = latest.posted_at
    ? new Date(latest.posted_at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  const stateColor =
    latest.state === 'APPROVED'
      ? 'text-emerald-700'
      : latest.state === 'CHANGES_REQUESTED'
        ? 'text-amber-700'
        : 'text-slate-600'

  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
      data-testid="code-review-summary"
    >
      <span className="font-medium text-slate-700">Code review:</span>
      <span className={`font-semibold ${stateColor}`} data-testid="code-review-summary-state">
        {stateText}
      </span>
      <span className="text-slate-500">
        by{' '}
        <span className="font-medium text-slate-700">{latest.reviewer_persona_id}</span>
        {timeText ? ` at ${timeText}` : ''}
      </span>
    </div>
  )
}
