/**
 * PRSummaryStrip — compact strip embedded above ACChecklist in UAT.
 *
 * Round 6 #1 — GitHub PR Loop
 * [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
 *
 * Shows: PR title/number, branch, status badge, "Open in GitHub" external link,
 * head SHA (short). Hidden when no PR is opened yet.
 */

import { trpc } from '../../../services/trpc.js'
import { PRBadge } from './PRBadge.js'

interface PRSummaryStripProps {
  /** The task ID to look up the PR for. */
  taskId: string
}

/**
 * Renders a summary strip with PR metadata above the ACChecklist.
 * Returns null when the task has no associated PR.
 */
export function PRSummaryStrip({ taskId }: PRSummaryStripProps) {
  const { data, isLoading } = trpc.prs.byTask.useQuery(
    { task_id: taskId },
    { refetchInterval: 30_000, refetchOnWindowFocus: false },
  )

  if (isLoading) {
    return (
      <div className="mb-3 h-10 animate-pulse rounded-md border border-slate-100 bg-slate-50" />
    )
  }

  const pr = data?.pr
  if (!pr) return null

  const shortSha = pr.head_sha ? pr.head_sha.slice(0, 7) : null

  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm"
      data-testid={`pr-summary-strip-${taskId}`}
    >
      <PRBadge taskId={taskId} />

      <span className="font-medium text-slate-700">PR #{pr.pr_number}</span>

      <span className="text-slate-400">·</span>

      <span className="truncate text-xs text-slate-500">
        {/* Branch info not returned by prs.byTask; show head SHA as proxy */}
        {shortSha ? `commit ${shortSha}` : 'branch pushed'}
      </span>

      {pr.pr_url && (
        <>
          <span className="ml-auto flex-shrink-0">
            <a
              href={pr.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open PR #${pr.pr_number} on GitHub`}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Open in GitHub
              <svg
                width="11"
                height="11"
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
          </span>
        </>
      )}
    </div>
  )
}
