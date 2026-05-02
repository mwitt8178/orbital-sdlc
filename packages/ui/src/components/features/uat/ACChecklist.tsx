/**
 * ACChecklist — list of acceptance criteria for a UAT session.
 *
 * Each AC has three states: pending, pass, fail. On state change we call
 * uat.ac.mark; the session query is invalidated so the new totals re-render.
 *
 * Round 4 additions:
 *   - Per-AC verifier signal icon (✓ green / ✗ red / ? amber / — slate)
 *   - PartialAcceptButton when at least one AC failed
 *
 * Round 5C additions:
 *   - Verifier signal is now driven by the real `uat.ac.evidence` query.
 *     The icon reflects the most recent verifier verdict, NOT the human's
 *     pass/fail mark. Click the icon to expand the EvidencePanel showing the
 *     captured test command, output, exit code, and (if applicable) LLM
 *     reasoning.
 *   - Empty state when no verifier evidence yet: small "verifier pending" chip.
 *
 * Round 6 #6 additions:
 *   - CI sub-icon (☁) shown when evidence_kind='ci_run'. Tooltip shows
 *     CI check name, conclusion, and run duration.
 *   [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useUATStore } from '../../../store/uat.js'
import { useHubSubscription } from '../../../hooks/useHubSubscription.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { PartialAcceptButton } from './PartialAcceptButton.js'
import { EvidencePanel, type EvidencePanelEvidence } from './EvidencePanel.js'

interface ACChecklistProps {
  sessionId: string
  /**
   * Round 6 #3: when provided, a "Report defect" link is shown per AC row.
   * taskId is the author task that produced the AC.
   * iterationCount is used to show the limit warning in the DefectReporter modal.
   * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
   */
  taskId?: string
  iterationCount?: number
}

// ---------------------------------------------------------------------------
// Verifier signal icon
// ---------------------------------------------------------------------------

type VerifierStatus = 'passed' | 'failed' | 'ambiguous' | 'pending' | 'none'

function VerifierIcon({
  status,
  expanded,
  onClick,
  disabled,
}: {
  status: VerifierStatus
  expanded: boolean
  onClick: () => void
  disabled: boolean
}) {
  const baseClasses =
    'flex h-5 w-5 items-center justify-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1'
  const cursorClass = disabled ? 'cursor-default' : 'cursor-pointer hover:scale-110'

  switch (status) {
    case 'passed':
      return (
        <button
          type="button"
          title="Verifier passed — click to view evidence"
          aria-label="Verifier passed; click to view evidence"
          aria-expanded={expanded}
          className={`${baseClasses} ${cursorClass} bg-emerald-100 text-emerald-600 focus:ring-emerald-500`}
          onClick={onClick}
          disabled={disabled}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      )
    case 'failed':
      return (
        <button
          type="button"
          title="Verifier failed — click to view evidence"
          aria-label="Verifier failed; click to view evidence"
          aria-expanded={expanded}
          className={`${baseClasses} ${cursorClass} bg-rose-100 text-rose-600 focus:ring-rose-500`}
          onClick={onClick}
          disabled={disabled}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )
    case 'ambiguous':
      return (
        <button
          type="button"
          title="Verifier ambiguous — click to view evidence"
          aria-label="Verifier ambiguous; click to view evidence"
          aria-expanded={expanded}
          className={`${baseClasses} ${cursorClass} bg-amber-100 text-amber-600 focus:ring-amber-500`}
          onClick={onClick}
          disabled={disabled}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
      )
    case 'pending':
      return (
        <span
          title="Verifier pending"
          aria-label="Verifier pending"
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" aria-hidden="true" />
          pending
        </span>
      )
    case 'none':
    default:
      return (
        <span
          title="No verifier"
          aria-label="No verifier"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-slate-400"
        >
          <span className="text-[10px] font-bold">—</span>
        </span>
      )
  }
}

// ---------------------------------------------------------------------------
// CI source sub-icon
// Round 6 #6 — shown when evidence_kind='ci_run'
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

/**
 * Small cloud icon shown alongside the verifier signal when CI evidence
 * is the primary source. Includes a tooltip with CI run summary.
 */
function CISubIcon({
  ciCheckName,
  ciConclusion,
  ciRunUrl,
}: {
  ciCheckName: string | null | undefined
  ciConclusion: string | null | undefined
  ciRunUrl: string | null | undefined
}) {
  const tooltip = [
    ciCheckName ? `CI: ${ciCheckName}` : 'CI run',
    ciConclusion ? `(${ciConclusion})` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const cloudIcon = (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  )

  if (ciRunUrl) {
    return (
      <a
        href={ciRunUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={tooltip}
        aria-label={tooltip}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-500 hover:bg-sky-200"
      >
        {cloudIcon}
      </a>
    )
  }

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-500"
    >
      {cloudIcon}
    </span>
  )
}

// ---------------------------------------------------------------------------
// AC Row — encapsulates the per-AC tRPC evidence query so we can render a
// stable list with one query per row. The query is keyed on ac_id.
// ---------------------------------------------------------------------------

interface ACRowProps {
  sessionId: string
  ac: {
    ac_id: string
    ac_ordinal: number
    text: string
    status: 'pending' | 'pass' | 'fail'
    observed_behavior: string | null
  }
  isOpen: boolean
  /** Round 6 #3: when provided, shows a "Report defect" link in the row. */
  taskId?: string
  iterationCount?: number
  onReportDefect?: (acId: string, acText: string) => void
}

function ACRow({ sessionId, ac, isOpen, taskId: _taskId, iterationCount: _ic, onReportDefect }: ACRowProps) {
  const utils = trpc.useUtils()
  const draftMap = useUATStore((s) => s.draftObservedBehavior)
  const setDraft = useUATStore((s) => s.setDraftObservedBehavior)

  const [evidenceOpen, setEvidenceOpen] = useState(false)

  const evidenceQuery = trpc.uat.ac.evidence.useQuery(
    { ac_id: ac.ac_id },
    { staleTime: 5_000 },
  )

  const markMutation = trpc.uat.ac.mark.useMutation({
    onSuccess: () => {
      void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
      void utils.uat.ac.evidence.invalidate({ ac_id: ac.ac_id })
    },
  })

  let verifierStatus: VerifierStatus
  if (evidenceQuery.isLoading) verifierStatus = 'pending'
  else if (evidenceQuery.data) {
    if (evidenceQuery.data.result === 'pass') verifierStatus = 'passed'
    else if (evidenceQuery.data.result === 'fail') verifierStatus = 'failed'
    else verifierStatus = 'ambiguous'
  } else {
    verifierStatus = 'none'
  }

  const evidence = evidenceQuery.data
  const canExpand = !!evidence

  return (
    <li role="listitem" className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">
          {ac.ac_ordinal}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-900">{ac.text}</p>
          {ac.status === 'fail' && (
            <textarea
              value={draftMap[ac.ac_id] ?? ac.observed_behavior ?? ''}
              onChange={(e) => setDraft(ac.ac_id, e.target.value)}
              placeholder="Observed behaviour (required for fail)"
              rows={2}
              className="mt-2 w-full resize-none rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-rose-500"
              aria-label={`Observed behaviour for AC ${ac.ac_ordinal}`}
            />
          )}
        </div>

        {/* Verifier signal icon + optional CI sub-icon */}
        <div className="flex flex-shrink-0 items-center gap-1">
          <VerifierIcon
            status={verifierStatus}
            expanded={evidenceOpen}
            disabled={!canExpand}
            onClick={() => {
              if (canExpand) setEvidenceOpen((v) => !v)
            }}
          />
          {/* CI sub-icon — Round 6 #6 */}
          {evidence?.evidence_kind === 'ci_run' && (
            <CISubIcon
              ciCheckName={(evidence as EvidencePanelEvidence).ci_check_name}
              ciConclusion={(evidence as EvidencePanelEvidence).ci_conclusion}
              ciRunUrl={(evidence as EvidencePanelEvidence).ci_run_url}
            />
          )}
        </div>

        <div className="flex flex-shrink-0 gap-1">
          <button
            type="button"
            className={`rounded border px-2 py-1 text-xs font-medium transition ${
              ac.status === 'pass'
                ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 text-slate-600 hover:bg-emerald-50'
            }`}
            onClick={() =>
              markMutation.mutate({
                uat_session_id: sessionId,
                ac_id: ac.ac_id,
                status: 'pass',
                evidence_links: [],
                justification: 'User marked AC as pass via UAT UI',
              })
            }
            disabled={!isOpen || markMutation.isPending}
            aria-pressed={ac.status === 'pass'}
            aria-label={`Mark AC ${ac.ac_ordinal} as pass`}
          >
            Pass
          </button>
          <button
            type="button"
            className={`rounded border px-2 py-1 text-xs font-medium transition ${
              ac.status === 'fail'
                ? 'border-rose-500 bg-rose-50 text-rose-700'
                : 'border-slate-200 text-slate-600 hover:bg-rose-50'
            }`}
            onClick={() => {
              const observed = draftMap[ac.ac_id] ?? ac.observed_behavior ?? ''
              if (!observed.trim()) {
                setDraft(ac.ac_id, '')
                return
              }
              markMutation.mutate({
                uat_session_id: sessionId,
                ac_id: ac.ac_id,
                status: 'fail',
                observed_behavior: observed.trim(),
                evidence_links: [],
                justification: 'User marked AC as fail via UAT UI',
              })
            }}
            disabled={!isOpen || markMutation.isPending}
            aria-pressed={ac.status === 'fail'}
            aria-label={`Mark AC ${ac.ac_ordinal} as fail`}
          >
            Fail
          </button>
        </div>
      </div>

      {evidenceOpen && evidence && <EvidencePanel evidence={evidence} />}

      {markMutation.error && (
        <p className="mt-2 text-xs text-rose-600" role="alert">
          {markMutation.error.message}
        </p>
      )}

      {/* Round 6 #3 — "Report defect" link per AC row */}
      {onReportDefect && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => onReportDefect(ac.ac_id, ac.text)}
            className="text-xs text-rose-500 hover:text-rose-700 hover:underline focus:outline-none focus:ring-2 focus:ring-rose-300"
            aria-label={`Report defect on AC ${ac.ac_ordinal}`}
          >
            Report defect
          </button>
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ACChecklist({ sessionId, taskId, iterationCount, onReportDefect }: ACChecklistProps & { onReportDefect?: (acId: string, acText: string) => void }) {
  const utils = trpc.useUtils()

  // Real-time hub subscription: when verifier evidence is recorded or a CI run
  // completes for this task, invalidate the AC evidence query so the verifier
  // signal icons update live without waiting for the next staleTime expiry.
  useHubSubscription(
    taskId ? `task:${taskId}` : '',
    (event) => {
      if (
        event.event_type !== 'VerifierEvidenceRecorded' &&
        event.event_type !== 'CIRunCompleted'
      ) {
        return
      }
      // Invalidate the session (pass/fail counts) and all AC evidence queries
      void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
      void utils.uat.ac.evidence.invalidate()
    },
    { enabled: !!taskId },
  )

  const sessionQuery = trpc.uat.session.get.useQuery(
    { uat_session_id: sessionId },
    { enabled: !!sessionId },
  )

  const submitMutation = trpc.uat.submit.useMutation({
    onSuccess: () => {
      void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
    },
  })

  const acceptMutation = trpc.uat.accept.useMutation({
    onSuccess: () => {
      void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
    },
  })

  if (sessionQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton rows={5} />
      </div>
    )
  }

  if (sessionQuery.error) {
    return <ErrorMessage title="Could not load session" message={sessionQuery.error.message} />
  }

  const data = sessionQuery.data
  if (!data || data.acceptance_criteria.length === 0) {
    return (
      <EmptyState
        title="No acceptance criteria"
        description="The story has no acceptance criteria attached."
      />
    )
  }

  const allMarked = data.acceptance_criteria.every((ac) => ac.status !== 'pending')
  const isOpen = data.session.state === 'started' || data.session.state === 'in_progress'
  const isSubmitted = data.session.state === 'submitted'
  const hasFailures = data.session.fail_count > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          {data.session.pass_count} pass · {data.session.fail_count} fail ·{' '}
          {data.acceptance_criteria.length - data.session.pass_count - data.session.fail_count}{' '}
          pending
        </div>
        <Badge color={isOpen ? 'blue' : isSubmitted ? 'amber' : 'emerald'}>
          {data.session.state}
        </Badge>
      </div>

      <ol className="space-y-3" role="list">
        {data.acceptance_criteria.map((ac) => (
          <ACRow
            key={ac.ac_id}
            sessionId={sessionId}
            ac={ac}
            isOpen={isOpen}
            taskId={taskId}
            iterationCount={iterationCount}
            onReportDefect={onReportDefect}
          />
        ))}
      </ol>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            submitMutation.mutate({
              uat_session_id: sessionId,
              confirm_unverified_assumptions: false,
              justification: 'User submitted UAT session via UI',
            })
          }
          disabled={!allMarked || !isOpen || submitMutation.isPending}
        >
          {submitMutation.isPending ? 'Submitting…' : 'Submit'}
        </Button>

        {isSubmitted && hasFailures && <PartialAcceptButton sessionId={sessionId} />}

        <Button
          onClick={() =>
            acceptMutation.mutate({
              uat_session_id: sessionId,
              mode: 'full',
              justification: 'User accepted UAT session via UI',
            })
          }
          disabled={!isSubmitted || acceptMutation.isPending}
        >
          {acceptMutation.isPending ? 'Accepting…' : 'Accept'}
        </Button>
      </div>

      {submitMutation.error && (
        <p className="text-xs text-rose-600" role="alert">
          {submitMutation.error.message}
        </p>
      )}
      {acceptMutation.error && (
        <p className="text-xs text-rose-600" role="alert">
          {acceptMutation.error.message}
        </p>
      )}
    </div>
  )
}
