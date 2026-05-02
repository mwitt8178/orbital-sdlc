/**
 * ReviewPanel — displays code review state and comments for a PR.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Mounted in PRDetailPanel "Reviews" tab.
 *
 * Shows:
 *   - State badge: APPROVED (green) / CHANGES_REQUESTED (red) / COMMENTED (gray)
 *   - Reviewer identity: persona icon + name + model used
 *   - Review summary body
 *   - Action buttons (operator):
 *     - "Override: mark approved" (logged)
 *     - "Request another reviewer" (creates a new code_review task)
 */

import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
// Round 7-08 — Operator-Attributed UI: reviewer badge in Reviews tab
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../../identity/OperatorBadge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPanelProps {
  /** GitHub PR number to load reviews for. */
  prNumber: number
  /** Task ID of the author task (for action mutations). */
  authorTaskId: string
}

type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'

// ---------------------------------------------------------------------------
// State display helpers
// ---------------------------------------------------------------------------

function stateLabel(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return 'Approved'
    case 'CHANGES_REQUESTED':
      return 'Changes Requested'
    case 'COMMENTED':
      return 'Commented'
  }
}

function stateBadgeClasses(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'CHANGES_REQUESTED':
      return 'bg-rose-100 text-rose-800 border-rose-200'
    case 'COMMENTED':
      return 'bg-slate-100 text-slate-700 border-slate-200'
  }
}

function stateIcon(state: ReviewState): string {
  switch (state) {
    case 'APPROVED':
      return '✓'
    case 'CHANGES_REQUESTED':
      return '✗'
    case 'COMMENTED':
      return '○'
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the reviews section for a PR, including state badge, reviewer identity,
 * review body, and operator action buttons.
 */
export function ReviewPanel({ prNumber, authorTaskId }: ReviewPanelProps) {
  const reviewsQuery = trpc.code_reviews.byPR.useQuery(
    { pr_number: prNumber },
    { staleTime: 30_000, refetchOnWindowFocus: false },
  )
  // Round 7-08 — Operator-Attributed UI: load team members for reviewer badge
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 60_000 })
  const memberMap = new Map<string, TeamMember>(
    (membersQuery.data ?? []).map((m) => [m.install_id, {
      install_id: m.install_id,
      display_name: m.display_name,
      role: m.role,
      last_seen_at: m.last_seen_at,
      color: m.color,
    }]),
  )

  const requestReworkMutation = trpc.code_reviews.requestRework.useMutation({
    onSuccess: () => {
      void reviewsQuery.refetch()
    },
  })

  if (reviewsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500"
          aria-hidden="true"
        />
        <span className="ml-2 text-xs text-slate-500">Loading reviews…</span>
      </div>
    )
  }

  if (reviewsQuery.error) {
    return (
      <div className="rounded-md bg-rose-50 p-4 text-xs text-rose-700">
        Failed to load reviews: {reviewsQuery.error.message}
      </div>
    )
  }

  const reviews = reviewsQuery.data?.reviews ?? []

  if (reviews.length === 0) {
    return (
      <div className="rounded-md bg-slate-50 p-4 text-sm text-slate-500">
        <p className="font-medium text-slate-700">No reviews yet</p>
        <p className="mt-1 text-xs">
          A reviewer persona will be spawned automatically after the PR is opened.
          The review will appear here once submitted.
        </p>
      </div>
    )
  }

  // Show all reviews, most recent last
  return (
    <div className="space-y-4">
      {reviews.map((review) => (
        <div
          key={review.review_id}
          className="rounded-md border border-slate-200 bg-white p-4"
          data-testid={`review-${review.review_id}`}
          data-review-state={review.state}
        >
          {/* Header: state badge + reviewer info */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold',
                  stateBadgeClasses(review.state as ReviewState),
                )}
                data-testid="review-state-badge"
              >
                <span aria-hidden="true">{stateIcon(review.state as ReviewState)}</span>
                {stateLabel(review.state as ReviewState)}
              </span>
              {/* Round 7-08 — show OperatorBadge for reviewer if install_id known */}
              {(() => {
                const installId = (review as Record<string, unknown>)['install_id'] as string | undefined
                if (installId) {
                  const member = memberMap.get(installId)
                  return (
                    <OperatorBadge
                      installId={installId}
                      member={member}
                      size="sm"
                    />
                  )
                }
                return (
                  <span className="text-xs text-slate-500">
                    by <span className="font-medium text-slate-700">{review.reviewer_persona_id}</span>
                  </span>
                )
              })()}
            </div>
            <span className="flex-shrink-0 text-[10px] text-slate-400">
              {review.posted_at
                ? new Date(review.posted_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'pending'}
            </span>
          </div>

          {/* Comments count */}
          {review.comments_count > 0 && (
            <p className="mt-1.5 text-xs text-slate-500">
              {review.comments_count} inline comment{review.comments_count === 1 ? '' : 's'}
            </p>
          )}

          {/* Review body */}
          {review.body && (
            <div className="mt-2 rounded-md bg-slate-50 px-3 py-2">
              <p className="whitespace-pre-wrap text-xs text-slate-700">{review.body}</p>
            </div>
          )}

          {/* Operator actions — only for CHANGES_REQUESTED */}
          {review.state === 'CHANGES_REQUESTED' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  requestReworkMutation.mutate({
                    review_id: review.review_id,
                    operator_feedback: undefined,
                  })
                }
                disabled={requestReworkMutation.isPending}
                className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
                aria-label="Request another review iteration"
              >
                {requestReworkMutation.isPending ? 'Requesting…' : 'Re-queue for rework'}
              </button>
            </div>
          )}

          {requestReworkMutation.isError && (
            <p className="mt-1 text-xs text-rose-600" role="alert">
              {requestReworkMutation.error.message}
            </p>
          )}
        </div>
      ))}

      {/* Latest approved state summary */}
      {reviews.some((r) => r.state === 'APPROVED') && (
        <div
          className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2"
          data-testid="review-approved-banner"
        >
          <span className="text-sm text-emerald-700" aria-live="polite">
            Ready to merge — approved by{' '}
            <span className="font-semibold">
              {reviews.find((r) => r.state === 'APPROVED')?.reviewer_persona_id ?? 'reviewer'}
            </span>
            {reviews.find((r) => r.state === 'APPROVED')?.posted_at
              ? ` at ${new Date(reviews.find((r) => r.state === 'APPROVED')!.posted_at!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </span>
        </div>
      )}
    </div>
  )
}
