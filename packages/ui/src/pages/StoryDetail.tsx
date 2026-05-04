/**
 * StoryDetail — single-story review surface.
 *
 * [Engineer-Principal · Opus · run-orbital-review-ui]
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Header: title, status, project, total cost, PR link     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Action bar: [Accept] [Send back] [Reject]               │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Tabs: Attempts (default) | Timeline                     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Attempt cards / timeline content                        │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Compare mode: when 2+ attempts exist, "Compare" button on attempt cards
 * adds them to a comparison panel (text-only side-by-side summaries +
 * diff/PR links).
 *
 * Live updates: subscribes to story:<id> via `addStorySubscription` and
 * invalidates byId/timeline/attempts queries when relevant events arrive.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { trpc } from '../services/trpc.js'
import { useEventsStore } from '../store/events.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { ErrorMessage } from '../components/ui/ErrorMessage.js'
import { Button } from '../components/ui/Button.js'
import { Modal } from '../components/ui/Modal.js'
import { Badge } from '../components/ui/Badge.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { addStorySubscription, removeStorySubscription } from '../store/storySubs.js'
import { TestArtifactsPanel } from '../components/features/stories/TestArtifactsPanel.js'

function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

interface AttemptRow {
  worker_run_id: string
  attempt_number: number
  started_at: string | Date
  ended_at: string | Date | null
  input_tokens: number | null
  output_tokens: number | null
  usd_cents: number | null
  exit_status: string | null
  pr_url: string | null
  branch_name: string | null
  summary: string | null
}

interface UnifiedHunkLine {
  origin: ' ' | '+' | '-'
  content: string
}

interface UnifiedHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: UnifiedHunkLine[]
}

interface UnifiedFile {
  path: string
  oldPath: string | null
  changeType: 'A' | 'M' | 'D' | 'R'
  additions: number
  deletions: number
  binary: boolean
  hunks: UnifiedHunk[]
}

export default function StoryDetail() {
  const { storyId = '' } = useParams<{ storyId: string }>()
  const navigate = useNavigate()
  const utils = trpc.useUtils()

  const headerQuery = trpc.stories.byId.useQuery({ story_id: storyId }, { enabled: !!storyId })
  const timelineQuery = trpc.stories.timeline.useQuery(
    { story_id: storyId },
    { enabled: !!storyId },
  )
  const attemptsQuery = trpc.stories.attempts.useQuery(
    { story_id: storyId },
    { enabled: !!storyId },
  )
  // PR Review Agent — latest automated review for this story
  // [Engineer-Sr · Sonnet · run-pr-review-agent-001]
  const prReviewQuery = trpc.pr_reviews.latest.useQuery(
    { story_id: storyId },
    { enabled: !!storyId },
  )

  const [tab, setTab] = useState<'attempts' | 'timeline'>('attempts')
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<null | 'accept' | 'reject' | 'redirect'>(null)

  // WS pattern subscription. Add story:<id> on mount, remove on unmount.
  useEffect(() => {
    if (!storyId) return
    addStorySubscription(storyId)
    return () => removeStorySubscription(storyId)
  }, [storyId])

  // Live invalidation
  const events = useEventsStore((s) => s.events)
  useEffect(() => {
    if (!storyId || events.length === 0) return
    const head = events[events.length - 1]
    if (!head) return
    const p = (head.payload ?? {}) as Record<string, unknown>
    const touchesThis =
      (head.aggregate_type === 'story' && head.aggregate_id === storyId) ||
      p['story_id'] === storyId
    if (touchesThis) {
      utils.stories.byId.invalidate({ story_id: storyId })
      utils.stories.timeline.invalidate({ story_id: storyId })
      utils.stories.attempts.invalidate({ story_id: storyId })
      utils.pr_reviews.latest.invalidate({ story_id: storyId })
    }
  }, [events, storyId, utils])

  // Story → PR pipeline: poll runStatus while a run is non-terminal.
  // [Engineer-Principal · Opus · run-story-pr-pipeline]
  const runStatusQuery = trpc.stories.runStatus.useQuery(
    { story_id: storyId },
    {
      enabled: !!storyId,
      refetchInterval: (q) => {
        const data = q.state.data as { run?: { status?: string } | null } | undefined
        const status = data?.run?.status
        const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled' || !status
        return terminal ? false : 3000
      },
    },
  )
  const runMut = trpc.stories.run.useMutation({
    onSuccess: () => {
      utils.stories.runStatus.invalidate({ story_id: storyId })
    },
  })

  const acceptMut = trpc.stories.accept.useMutation({
    onSuccess: () => {
      utils.stories.byId.invalidate({ story_id: storyId })
      utils.stories.list.invalidate()
      setConfirm(null)
      navigate('/stories')
    },
  })
  const rejectMut = trpc.stories.reject.useMutation({
    onSuccess: () => {
      utils.stories.byId.invalidate({ story_id: storyId })
      utils.stories.list.invalidate()
      setConfirm(null)
      navigate('/stories')
    },
  })
  const redirectMut = trpc.stories.redirect.useMutation({
    onSuccess: () => {
      utils.stories.byId.invalidate({ story_id: storyId })
      utils.stories.list.invalidate()
      setConfirm(null)
      navigate('/stories')
    },
  })

  const attempts = useMemo(
    () => (attemptsQuery.data?.attempts ?? []) as unknown as AttemptRow[],
    [attemptsQuery.data],
  )

  const compareList = useMemo(
    () => attempts.filter((a) => compareSet.has(a.worker_run_id)),
    [attempts, compareSet],
  )

  if (!storyId) return <ErrorMessage message="Missing storyId" />

  if (headerQuery.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (headerQuery.isError || !headerQuery.data) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <ErrorMessage message={headerQuery.error?.message ?? 'Story not found'} />
        <div className="mt-4">
          <Link to="/stories" className="text-sm text-brand-600 hover:underline">
            ← Back to queue
          </Link>
        </div>
      </div>
    )
  }

  const { story, task, project, totalCostUsd } = headerQuery.data
  const status = story.status as string
  const isReviewable = status === 'in_review'

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <ProjectBreadcrumb />
        <span aria-hidden="true">›</span>
        <Link to="/stories" className="hover:text-slate-700 hover:underline">
          Review queue
        </Link>
        <span aria-hidden="true">›</span>
        <span>Story</span>
      </div>
      <Link to="/stories" className="text-sm text-brand-600 hover:underline">
        ← Back to queue
      </Link>

      {/* Header */}
      <header className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              {story.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Badge color={status === 'in_review' ? 'amber' : 'slate'}>
                {status.replace('_', ' ')}
              </Badge>
              {project?.name && <span>· {project.name}</span>}
              {task?.githubPrUrl && (
                <a
                  href={task.githubPrUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-600 hover:underline"
                >
                  PR #{task.githubPrNumber}
                </a>
              )}
            </div>
            {story.redirectNote && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                <p className="font-medium">Pending redirect:</p>
                <p className="mt-0.5 whitespace-pre-wrap">{story.redirectNote}</p>
              </div>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">Total cost</p>
            <p className="font-mono text-2xl text-slate-900">{formatUsd(totalCostUsd)}</p>
          </div>
        </div>
      </header>

      {/* Story → PR pipeline status block */}
      <StoryPrRunBlock
        run={runStatusQuery.data?.run ?? null}
        running={runMut.isPending}
        error={runMut.error?.message ?? null}
        onRun={() => runMut.mutate({ story_id: storyId })}
      />

      {/* Action bar */}
      <section
        className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3"
        aria-label="Review actions"
      >
        <Button
          variant="primary"
          disabled={!isReviewable || !task?.githubPrNumber}
          onClick={() => setConfirm('accept')}
          data-testid="action-accept"
        >
          Accept &amp; merge
        </Button>
        <Button
          variant="secondary"
          disabled={!isReviewable}
          onClick={() => setConfirm('redirect')}
          data-testid="action-redirect"
        >
          Send back with redirect
        </Button>
        <Button
          variant="danger"
          disabled={!isReviewable}
          onClick={() => setConfirm('reject')}
          data-testid="action-reject"
        >
          Reject
        </Button>
        {!isReviewable && (
          <p className="ml-2 text-xs text-slate-500">
            Story is not in review. Actions disabled.
          </p>
        )}
      </section>

      {/* QA Generated Tests — shown before engineer starts */}
      <TestArtifactsPanel
        storyId={storyId}
        projectId={task?.projectId ?? null}
        storyBranch={task?.githubHeadSha ? `feat/${storyId.slice(0, 8)}` : 'main'}
      />

      {/* PR Review Panel — automated PASS/BLOCK review from the review agent */}
      <ReviewPanel
        loading={prReviewQuery.isLoading}
        review={prReviewQuery.data?.review ?? null}
      />

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200">
        <TabBtn active={tab === 'attempts'} onClick={() => setTab('attempts')}>
          Attempts ({attempts.length})
        </TabBtn>
        <TabBtn active={tab === 'timeline'} onClick={() => setTab('timeline')}>
          Timeline
        </TabBtn>
      </div>

      {tab === 'attempts' && (
        <AttemptsTab
          storyId={storyId}
          loading={attemptsQuery.isLoading}
          attempts={attempts}
          compareSet={compareSet}
          toggleCompare={(id) =>
            setCompareSet((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
        />
      )}

      {tab === 'timeline' && (
        <TimelineTab
          loading={timelineQuery.isLoading}
          items={(timelineQuery.data?.items ?? []) as TimelineItem[]}
        />
      )}

      {compareList.length >= 2 && (
        <ComparePanel
          storyId={storyId}
          attempts={compareList}
          onClose={() => setCompareSet(new Set())}
        />
      )}

      {/* Confirmation modals */}
      <Modal open={confirm === 'accept'} onClose={() => setConfirm(null)} title="Accept and merge?">
        <div className="space-y-3 p-4">
          <p className="text-sm text-slate-700">
            This will squash-merge PR #{task?.githubPrNumber} on GitHub and mark the
            story <span className="font-mono">done</span>. There is no undo.
          </p>
          {acceptMut.error && (
            <ErrorMessage message={acceptMut.error.message} />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={acceptMut.isPending || !task?.taskId}
              onClick={() =>
                task?.taskId &&
                acceptMut.mutate({
                  story_id: storyId,
                  task_id: task.taskId,
                  mergeMethod: 'squash',
                })
              }
              data-testid="confirm-accept"
            >
              {acceptMut.isPending ? 'Merging…' : 'Confirm merge'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={confirm === 'reject'} onClose={() => setConfirm(null)} title="Reject this story?">
        <RejectForm
          loading={rejectMut.isPending}
          error={rejectMut.error?.message ?? null}
          onCancel={() => setConfirm(null)}
          onSubmit={(reason) => rejectMut.mutate({ story_id: storyId, reason })}
        />
      </Modal>

      <Modal
        open={confirm === 'redirect'}
        onClose={() => setConfirm(null)}
        title="Send back with redirect"
      >
        <RedirectForm
          loading={redirectMut.isPending}
          error={redirectMut.error?.message ?? null}
          onCancel={() => setConfirm(null)}
          onSubmit={(note) => redirectMut.mutate({ story_id: storyId, redirect_note: note })}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PR Review Panel
// [Engineer-Sr · Sonnet · run-pr-review-agent-001]
// ---------------------------------------------------------------------------

interface ReviewFinding {
  file: string
  line: number | null
  severity: 'info' | 'warning' | 'error'
  category: 'correctness' | 'security' | 'multi-tenant' | 'observability'
  message: string
}

interface PrReview {
  verdict: 'PASS' | 'BLOCK'
  prUrl: string
  findings: ReviewFinding[]
  reviewerPersona: string
  createdAt: string | Date
}

function ReviewPanel({ loading, review }: { loading: boolean; review: PrReview | null }) {
  if (loading) return <Skeleton className="h-16 w-full" />
  if (!review) return null

  const isPass = review.verdict === 'PASS'

  return (
    <section
      className={clsx(
        'rounded-lg border p-4',
        isPass ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50',
      )}
      aria-label="Automated PR review"
      data-testid="pr-review-panel"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge color={isPass ? 'emerald' : 'rose'} data-testid="pr-review-verdict">
          {isPass ? 'PASS' : 'BLOCK'}
        </Badge>
        <span className="text-xs text-slate-600">Automated review by {review.reviewerPersona}</span>
        {review.prUrl && (
          <a
            href={review.prUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-brand-600 hover:underline"
          >
            View PR
          </a>
        )}
      </div>

      {review.findings.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Review findings" data-testid="pr-review-findings">
          {review.findings.map((f, i) => (
            <li key={i} className="flex flex-wrap items-start gap-2 text-xs text-slate-700">
              <Badge color={severityColor(f.severity)}>{f.severity}</Badge>
              <Badge color={categoryColor(f.category)}>{f.category}</Badge>
              <span className="flex-1">
                {f.file && (
                  <span className="font-mono text-slate-500">
                    {f.file}{f.line != null ? `:${f.line}` : ''}
                    {' '}
                  </span>
                )}
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {review.findings.length === 0 && (
        <p className="mt-2 text-xs text-slate-500">No findings — clean review.</p>
      )}
    </section>
  )
}

function severityColor(severity: ReviewFinding['severity']): 'rose' | 'amber' | 'blue' {
  switch (severity) {
    case 'error': return 'rose'
    case 'warning': return 'amber'
    default: return 'blue'
  }
}

function categoryColor(category: ReviewFinding['category']): 'rose' | 'amber' | 'violet' | 'slate' {
  switch (category) {
    case 'security': return 'rose'
    case 'multi-tenant': return 'amber'
    case 'observability': return 'violet'
    default: return 'slate'
  }
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
        active
          ? 'border-brand-500 text-slate-900'
          : 'border-transparent text-slate-500 hover:text-slate-700',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Attempts tab
// ---------------------------------------------------------------------------

function AttemptsTab({
  storyId,
  loading,
  attempts,
  compareSet,
  toggleCompare,
}: {
  storyId: string
  loading: boolean
  attempts: AttemptRow[]
  compareSet: Set<string>
  toggleCompare: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  if (loading) return <Skeleton className="h-40 w-full" />
  if (attempts.length === 0) {
    return (
      <EmptyState
        title="No attempts yet"
        description="The StoryExecutor has not produced a worker run for this story, or worker_runs is not yet recording. Reviewer actions still work."
      />
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-3">
      {attempts.map((a) => {
        const cents = a.usd_cents ?? 0
        const cost = cents / 100
        const exit = a.exit_status ?? 'unknown'
        const tone = exit === 'success' ? 'emerald' : exit === 'failed' ? 'rose' : 'slate'
        return (
          <li
            key={a.worker_run_id}
            className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4"
            data-testid={`attempt-${a.attempt_number}`}
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">
                Attempt #{a.attempt_number}
              </p>
              <Badge color={tone}>{exit}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
              <div>
                <span className="text-slate-400">Started: </span>
                {new Date(a.started_at).toLocaleString()}
              </div>
              <div>
                <span className="text-slate-400">Ended: </span>
                {a.ended_at ? new Date(a.ended_at).toLocaleString() : '—'}
              </div>
              <div>
                <span className="text-slate-400">Tokens: </span>
                {(a.input_tokens ?? 0).toLocaleString()} in /{' '}
                {(a.output_tokens ?? 0).toLocaleString()} out
              </div>
              <div>
                <span className="text-slate-400">Cost: </span>
                <span className="font-mono">{formatUsd(cost)}</span>
              </div>
            </div>
            {a.summary && (
              <p className="line-clamp-3 text-xs text-slate-700">{a.summary}</p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {a.pr_url && (
                <a
                  href={a.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-brand-600 hover:underline"
                >
                  Diff / PR
                </a>
              )}
              {a.branch_name && (
                <span className="font-mono text-[10px] text-slate-500">{a.branch_name}</span>
              )}
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(a.worker_run_id)) next.delete(a.worker_run_id)
                    else next.add(a.worker_run_id)
                    return next
                  })
                }
                className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
                data-testid={`toggle-diff-${a.attempt_number}`}
              >
                {expanded.has(a.worker_run_id) ? 'Hide diff' : 'Show diff'}
              </button>
              <button
                type="button"
                onClick={() => toggleCompare(a.worker_run_id)}
                className={clsx(
                  'rounded-md border px-2 py-1 text-xs transition',
                  compareSet.has(a.worker_run_id)
                    ? 'border-brand-300 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {compareSet.has(a.worker_run_id) ? 'Comparing' : 'Compare'}
              </button>
            </div>
            {expanded.has(a.worker_run_id) && (
              <AttemptDiff storyId={storyId} attemptNumber={a.attempt_number} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// AttemptDiff — provider-agnostic unified-diff renderer
// ---------------------------------------------------------------------------

function AttemptDiff({
  storyId,
  attemptNumber,
}: {
  storyId: string
  attemptNumber: number
}) {
  const q = trpc.stories.getAttemptDiff.useQuery(
    { story_id: storyId, attempt_number: attemptNumber },
    { staleTime: 30_000 },
  )

  if (q.isLoading) {
    return <Skeleton className="mt-3 h-32 w-full" />
  }
  if (q.isError) {
    return (
      <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
        Failed to load diff: {q.error?.message ?? 'unknown error'}
      </div>
    )
  }
  const data = q.data
  if (!data) return null

  const provider = data.provider ?? 'unknown'
  const isCodeCommit = provider === 'codecommit' || provider === 'internal'

  return (
    <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge color={isCodeCommit ? 'amber' : provider === 'github' ? 'slate' : 'slate'}>
          {provider}
        </Badge>
        {data.fromRef && data.toRef && (
          <span className="font-mono">
            {data.fromRef} … {data.toRef}
          </span>
        )}
        {data.repoUrl && (
          <a
            href={data.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 hover:underline"
          >
            Open repo
          </a>
        )}
      </div>
      {isCodeCommit && (
        <div className="rounded-md border border-amber-100 bg-amber-50/50 p-2 text-[11px] text-amber-800">
          For local clones, configure the{' '}
          <a
            className="underline"
            href="https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-https-unixes.html"
            target="_blank"
            rel="noreferrer"
          >
            AWS CodeCommit credential helper
          </a>
          .
        </div>
      )}
      {data.error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          {data.error}
        </div>
      )}
      {data.files.length === 0 && !data.error && (
        <EmptyState
          title="No file changes"
          description="The branch has no differences against the default branch."
        />
      )}
      {data.files.map((f) => (
        <FileDiff key={f.path} file={f as UnifiedFile} />
      ))}
    </div>
  )
}

function FileDiff({ file }: { file: UnifiedFile }) {
  const tone =
    file.changeType === 'A'
      ? 'emerald'
      : file.changeType === 'D'
        ? 'rose'
        : file.changeType === 'R'
          ? 'amber'
          : 'slate'
  return (
    <section
      className="overflow-hidden rounded-md border border-slate-200"
      data-testid={`file-diff-${file.path}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <Badge color={tone}>{file.changeType}</Badge>
        <span className="font-mono text-slate-800">{file.path}</span>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="font-mono text-slate-500">(was {file.oldPath})</span>
        )}
        <span className="ml-auto font-mono text-slate-500">
          <span className="text-emerald-600">+{file.additions}</span>{' '}
          <span className="text-rose-600">-{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <p className="p-3 text-xs text-slate-500">Binary file — diff suppressed.</p>
      ) : file.hunks.length === 0 ? (
        <p className="p-3 text-xs text-slate-500">No textual changes.</p>
      ) : (
        <div className="overflow-x-auto">
          {file.hunks.map((h, hi) => (
            <Hunk key={hi} hunk={h} />
          ))}
        </div>
      )}
    </section>
  )
}

function Hunk({ hunk }: { hunk: UnifiedHunk }) {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return (
    <div className="font-mono text-[11px] leading-5">
      <div className="bg-slate-100 px-3 py-1 text-slate-600">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((ln, i) => {
        const oldShown = ln.origin === '+' ? '' : String(oldNo)
        const newShown = ln.origin === '-' ? '' : String(newNo)
        if (ln.origin !== '+') oldNo++
        if (ln.origin !== '-') newNo++
        const bg =
          ln.origin === '+'
            ? 'bg-emerald-50 text-emerald-900'
            : ln.origin === '-'
              ? 'bg-rose-50 text-rose-900'
              : 'bg-white text-slate-800'
        return (
          <div key={i} className={clsx('flex whitespace-pre', bg)}>
            <span className="w-12 shrink-0 select-none border-r border-slate-100 px-1 text-right text-slate-400">
              {oldShown}
            </span>
            <span className="w-12 shrink-0 select-none border-r border-slate-100 px-1 text-right text-slate-400">
              {newShown}
            </span>
            <span className="w-4 shrink-0 select-none text-center text-slate-400">
              {ln.origin === ' ' ? '' : ln.origin}
            </span>
            <span className="grow px-1">{ln.content}</span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline tab
// ---------------------------------------------------------------------------

interface TimelineItem {
  kind: 'channel_post'
  at: string | Date
  type: string
  author: { type?: string; display_name?: string; persona_role?: string } | null
  payload: Record<string, unknown>
  id: string
}

function TimelineTab({ loading, items }: { loading: boolean; items: TimelineItem[] }) {
  if (loading) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) {
    return <EmptyState title="No events yet" description="The story has no recorded activity." />
  }
  return (
    <ol className="flex flex-col gap-2">
      {items.map((it) => {
        const body = (it.payload as { body?: string }).body ?? ''
        const author =
          it.author?.display_name ?? it.author?.persona_role ?? it.author?.type ?? 'system'
        return (
          <li
            key={it.id}
            className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700"
          >
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{author}</span>
              <span>{new Date(it.at).toLocaleString()}</span>
            </div>
            {body && <p className="mt-1 whitespace-pre-wrap text-slate-800">{body}</p>}
          </li>
        )
      })}
    </ol>
  )
}

// ---------------------------------------------------------------------------
// Compare panel (text-only side-by-side)
// ---------------------------------------------------------------------------

function ComparePanel({
  storyId,
  attempts,
  onClose,
}: {
  storyId: string
  attempts: AttemptRow[]
  onClose: () => void
}) {
  // Sort by attempt_number ascending for a stable from→to.
  const sorted = [...attempts].sort((a, b) => a.attempt_number - b.attempt_number)
  const from = sorted[0]
  const to = sorted[sorted.length - 1]
  const enabled = !!from && !!to && from.attempt_number !== to.attempt_number
  const diffQuery = trpc.stories.getCompareDiff.useQuery(
    {
      story_id: storyId,
      from_attempt: from?.attempt_number ?? 1,
      to_attempt: to?.attempt_number ?? 1,
    },
    { enabled, staleTime: 30_000 },
  )
  return (
    <section
      aria-label="Compare attempts"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          Compare attempts {from && to && `#${from.attempt_number} → #${to.attempt_number}`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          Clear
        </button>
      </div>
      <div
        className="mb-3 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${sorted.length}, minmax(0, 1fr))` }}
      >
        {sorted.map((a) => (
          <div key={a.worker_run_id} className="rounded-md border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-900">Attempt #{a.attempt_number}</p>
            <p className="mt-1 text-xs text-slate-500">
              {a.exit_status ?? 'unknown'} · {formatUsd((a.usd_cents ?? 0) / 100)}
            </p>
            {a.summary && <p className="mt-2 text-xs text-slate-700">{a.summary}</p>}
          </div>
        ))}
      </div>
      {!enabled && (
        <p className="text-xs text-slate-500">
          Pick two distinct attempts to see a head-to-head diff.
        </p>
      )}
      {enabled && diffQuery.isLoading && <Skeleton className="h-32 w-full" />}
      {enabled && diffQuery.isError && (
        <ErrorMessage message={diffQuery.error?.message ?? 'Failed to load diff'} />
      )}
      {enabled && diffQuery.data && (
        <div className="space-y-2">
          {diffQuery.data.error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {diffQuery.data.error}
            </div>
          )}
          {(diffQuery.data.files as UnifiedFile[]).map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
          {diffQuery.data.files.length === 0 && !diffQuery.data.error && (
            <EmptyState title="No differences" description="The two attempts produced identical trees." />
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function RejectForm({
  loading,
  error,
  onCancel,
  onSubmit,
}: {
  loading: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-slate-700">
        Reject moves the story to <span className="font-mono">cancelled</span>. The PR
        is left open for cleanup.
      </p>
      <label className="block text-xs font-medium text-slate-700">
        Reason (visible in channel)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
          placeholder="Why is this being rejected?"
          data-testid="reject-reason"
        />
      </label>
      {error && <ErrorMessage message={error} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={loading || reason.trim().length === 0}
          onClick={() => onSubmit(reason.trim())}
          data-testid="confirm-reject"
        >
          {loading ? 'Rejecting…' : 'Confirm reject'}
        </Button>
      </div>
    </div>
  )
}

function RedirectForm({
  loading,
  error,
  onCancel,
  onSubmit,
}: {
  loading: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (note: string) => void
}) {
  const [note, setNote] = useState('')
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-slate-700">
        Send the story back to <span className="font-mono">ready</span> with feedback
        for the StoryExecutor. The agent will pick this up on its next tick.
      </p>
      <label className="block text-xs font-medium text-slate-700">
        Redirect note
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={5}
          className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
          placeholder="What needs to change?"
          data-testid="redirect-note"
        />
      </label>
      {error && <ErrorMessage message={error} />}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={loading || note.trim().length === 0}
          onClick={() => onSubmit(note.trim())}
          data-testid="confirm-redirect"
        >
          {loading ? 'Sending…' : 'Send back'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Story → PR run block
// [Engineer-Principal · Opus · run-story-pr-pipeline]
// ---------------------------------------------------------------------------

interface RunStatusRow {
  run_id: string
  status: string
  branch: string
  pr_url: string | null
  commit_sha: string | null
  diff_stats: { files?: number; additions?: number; deletions?: number; error?: string } | null
  started_at: string | Date
  finished_at: string | Date | null
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  cloning: 'Cloning repository',
  branching: 'Creating branch',
  running_agent: 'Agent working',
  committing: 'Committing changes',
  pushing: 'Pushing branch',
  opening_pr: 'Opening pull request',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function StoryPrRunBlock({
  run,
  running,
  error,
  onRun,
}: {
  run: RunStatusRow | null
  running: boolean
  error: string | null
  onRun: () => void
}) {
  const status = run?.status ?? null
  const terminal = !status || status === 'succeeded' || status === 'failed' || status === 'cancelled'
  const inFlight = !!status && !terminal

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3"
      aria-label="Story PR run"
      data-testid="story-pr-run-block"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Agent run</p>
          <p className="text-xs text-slate-500">
            Run the engineer agent in a fresh worktree, commit, and open a pull request.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={onRun}
          disabled={running || inFlight}
          data-testid="action-run-agent"
        >
          {running ? 'Starting…' : inFlight ? 'Running…' : 'Run agent'}
        </Button>
      </div>

      {error && <ErrorMessage message={error} />}

      {run && (
        <div className="rounded-md border border-slate-100 bg-slate-50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={status === 'succeeded' ? 'emerald' : status === 'failed' ? 'rose' : 'amber'}>
              {STATUS_LABEL[status ?? ''] ?? status}
            </Badge>
            <span className="font-mono text-xs text-slate-500">{run.branch}</span>
          </div>

          {status === 'succeeded' && run.pr_url && (
            <div className="mt-2 space-y-1">
              <a
                href={run.pr_url}
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 hover:underline"
                data-testid="run-pr-link"
              >
                Open pull request →
              </a>
              {run.diff_stats && (
                <p className="font-mono text-xs text-slate-500">
                  {run.diff_stats.files ?? 0} files,{' '}
                  <span className="text-emerald-600">+{run.diff_stats.additions ?? 0}</span>{' '}
                  <span className="text-rose-600">-{run.diff_stats.deletions ?? 0}</span>
                </p>
              )}
            </div>
          )}

          {status === 'failed' && (
            <p className="mt-2 text-xs text-rose-700" data-testid="run-failure-msg">
              {run.diff_stats?.error ?? 'Run failed.'}
            </p>
          )}

          {inFlight && (
            <p className="mt-2 text-xs text-slate-500">
              Live updates poll every 3 seconds.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
