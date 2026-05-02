/**
 * PRBadge — compact status badge for a GitHub pull request.
 *
 * Round 6 #1 — GitHub PR Loop
 * [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
 *
 * Round 6 #2 — Code-Review Persona: review sub-states
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * PR states: none (—), open (yellow), merged (green), closed (gray)
 * Review sub-states (when PR is open):
 *   awaiting_review  — reviewer task created, pending
 *   changes_requested — reviewer requested changes (orange)
 *   approved          — reviewer approved (green ring)
 *
 * Hover: tooltip with PR number, head SHA, and review state.
 * Click: opens PRDetailPanel drawer (via onOpenDetail callback or store).
 */

import { useState } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PRState = 'open' | 'merged' | 'closed' | 'none'

/**
 * Round 6 #2 — review sub-state for an open PR.
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 */
export type ReviewSubState = 'awaiting_review' | 'changes_requested' | 'approved' | null

interface PRInfo {
  pr_number: number
  pr_url: string | null
  pr_state: PRState
  head_sha: string | null
  merged_at: string | null
}

interface PRBadgeProps {
  taskId: string
  /** Called when the badge is clicked — opens the PR detail drawer. */
  onOpenDetail?: (taskId: string, prInfo: PRInfo) => void
  /**
   * Round 6 #3: when > 0, a "rerolled Nx" badge is shown alongside the PR badge.
   * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
   */
  iterationCount?: number
  /**
   * Round 6 #2: review sub-state from tasks.code_review_state.
   * Shown as a secondary badge when PR is open.
   * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
   */
  reviewSubState?: ReviewSubState
}

// ---------------------------------------------------------------------------
// State → style mapping
// ---------------------------------------------------------------------------

function stateLabel(state: PRState): string {
  switch (state) {
    case 'open':
      return 'Open'
    case 'merged':
      return 'Merged'
    case 'closed':
      return 'Closed'
    default:
      return '—'
  }
}

function stateClasses(state: PRState): string {
  switch (state) {
    case 'open':
      return 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
    case 'merged':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
    case 'closed':
      return 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
    default:
      return 'bg-transparent text-slate-400 border-transparent cursor-default'
  }
}

// ---------------------------------------------------------------------------
// Review sub-state helpers (Round 6 #2)
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
// ---------------------------------------------------------------------------

function reviewSubStateLabel(sub: ReviewSubState): string {
  switch (sub) {
    case 'awaiting_review':
      return 'Awaiting Review'
    case 'changes_requested':
      return 'Changes Requested'
    case 'approved':
      return 'Approved'
    default:
      return ''
  }
}

function reviewSubStateClasses(sub: ReviewSubState): string {
  switch (sub) {
    case 'awaiting_review':
      return 'bg-sky-50 text-sky-700 border-sky-200'
    case 'changes_requested':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'approved':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a compact status badge for the PR associated with the given task.
 * Fetches PR data from the `prs.byTask` tRPC procedure.
 *
 * Shows "—" when no PR has been opened yet (feature flag off or task not complete).
 * Shows a review sub-state badge when reviewSubState is provided.
 */
export function PRBadge({ taskId, onOpenDetail, iterationCount = 0, reviewSubState = null }: PRBadgeProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false)

  const { data, isLoading } = trpc.prs.byTask.useQuery(
    { task_id: taskId },
    {
      // Refetch every 30s to pick up webhook-driven state changes
      refetchInterval: 30_000,
      // Don't refetch on every window focus — this is supplemental data
      refetchOnWindowFocus: false,
    },
  )

  if (isLoading) {
    return (
      <span
        className="inline-block h-5 w-10 animate-pulse rounded border border-slate-100 bg-slate-100"
        aria-label="Loading PR status"
      />
    )
  }

  const pr = data?.pr
  const state: PRState = pr ? (pr.pr_state as PRState) : 'none'

  const handleClick = () => {
    if (!pr || !onOpenDetail) return
    onOpenDetail(taskId, {
      pr_number: pr.pr_number,
      pr_url: pr.pr_url,
      pr_state: state,
      head_sha: pr.head_sha ?? null,
      merged_at: pr.merged_at ?? null,
    })
  }

  const tooltipText = pr
    ? `PR #${pr.pr_number} · ${pr.head_sha ? pr.head_sha.slice(0, 7) : 'no SHA'}`
    : 'No PR opened yet'

  return (
    <div className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`PR status: ${stateLabel(state)}${pr ? ` (#${pr.pr_number})` : ''}`}
        disabled={state === 'none'}
        onClick={handleClick}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => setTooltipVisible(true)}
        onBlur={() => setTooltipVisible(false)}
        className={clsx(
          'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium transition',
          stateClasses(state),
          state === 'none' ? '' : 'cursor-pointer',
        )}
        data-testid={`pr-badge-${taskId}`}
      >
        {stateLabel(state)}
      </button>

      {/* Round 6 #2 — review sub-state badge */}
      {reviewSubState && state === 'open' && (
        <span
          aria-label={`Review: ${reviewSubStateLabel(reviewSubState)}`}
          className={clsx(
            'inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-medium',
            reviewSubStateClasses(reviewSubState),
          )}
          data-testid={`pr-badge-review-state-${taskId}`}
        >
          {reviewSubStateLabel(reviewSubState)}
        </span>
      )}

      {/* Round 6 #3 — "rerolled Nx" badge when task has been iterated */}
      {iterationCount > 0 && (
        <span
          title={`${iterationCount} defect-driven iteration${iterationCount === 1 ? '' : 's'}`}
          aria-label={`rerolled ${iterationCount} time${iterationCount === 1 ? '' : 's'}`}
          className="inline-flex items-center rounded border border-violet-200 bg-violet-50 px-1 py-0.5 text-[10px] font-medium text-violet-700"
          data-testid={`pr-badge-rerolled-${taskId}`}
        >
          rerolled {iterationCount}×
        </span>
      )}

      {tooltipVisible && (
        <div
          role="tooltip"
          className="absolute bottom-full left-0 z-50 mb-1 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow-md"
        >
          {tooltipText}
        </div>
      )}
    </div>
  )
}
