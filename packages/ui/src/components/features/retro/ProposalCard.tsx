/**
 * ProposalCard — single retro proposal with approve/reject/defer actions.
 *
 * Approve requires confirm dialog (potentially merges to system version);
 * reject/defer require rationale input but no extra confirmation step.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { useToast } from '../../../services/use-toast.js'

const USER_ID = 'local-user'

interface ProposalRow {
  retro_proposal_id: string
  proposal_code: string
  title: string
  hypothesis: string
  status: string
  expected_impact_metric: string | null
  expected_impact_pct_points: number | null
  confidence_score: number | null
  decided_by: string | null
  pr_ref: string | null
  merged_system_version_id: string | null
}

interface ProposalCardProps {
  proposal: ProposalRow
  onChanged: () => void
}

export function ProposalCard({ proposal, onChanged }: ProposalCardProps) {
  const [confirmAction, setConfirmAction] = useState<'approve' | null>(null)
  const [rationale, setRationale] = useState('')
  const [error, setError] = useState<string | null>(null)
  const utils = trpc.useUtils()
  const toast = useToast()

  const onSettled = () => {
    onChanged()
    void utils.retro.proposal.list.invalidate()
  }

  const approveMutation = trpc.retro.proposal.approve.useMutation({
    onSuccess: () => {
      setConfirmAction(null)
      setRationale('')
      onSettled()
      toast.success('Proposal approved', {
        description: `${proposal.proposal_code} is queued to merge.`,
      })
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Approve failed', { description: err.message })
    },
  })

  const rejectMutation = trpc.retro.proposal.reject.useMutation({
    onSuccess: () => {
      setRationale('')
      onSettled()
      toast.info(`Proposal ${proposal.proposal_code} rejected`)
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Reject failed', { description: err.message })
    },
  })

  const deferMutation = trpc.retro.proposal.defer.useMutation({
    onSuccess: () => {
      setRationale('')
      onSettled()
      toast.info(`Proposal ${proposal.proposal_code} deferred`)
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Defer failed', { description: err.message })
    },
  })

  const isPending = proposal.status === 'pending'

  const handleAct = (action: 'approve' | 'reject' | 'defer') => {
    if (!rationale.trim()) {
      setError('Rationale is required')
      return
    }
    setError(null)
    if (action === 'approve') {
      approveMutation.mutate({
        retro_proposal_id: proposal.retro_proposal_id,
        rationale: rationale.trim(),
        user_id: USER_ID,
      })
    } else if (action === 'reject') {
      rejectMutation.mutate({
        retro_proposal_id: proposal.retro_proposal_id,
        rationale: rationale.trim(),
        user_id: USER_ID,
      })
    } else {
      deferMutation.mutate({
        retro_proposal_id: proposal.retro_proposal_id,
        rationale: rationale.trim(),
        user_id: USER_ID,
      })
    }
  }

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5">
      <header className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-slate-500">{proposal.proposal_code}</span>
            <StatusBadge status={proposal.status} />
          </div>
          <h3 className="mt-1 text-base font-semibold text-slate-900">{proposal.title}</h3>
        </div>
        {proposal.confidence_score !== null && (
          <div className="ml-3 flex-shrink-0 text-right">
            <div className="text-xs text-slate-500">Confidence</div>
            <div className="font-mono text-sm font-bold text-indigo-600">
              {Math.round(proposal.confidence_score * 100)}%
            </div>
          </div>
        )}
      </header>

      <p className="mt-2 text-sm text-slate-700">{proposal.hypothesis}</p>

      {proposal.expected_impact_metric && (
        <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs">
          <span className="text-slate-500">Expected impact:</span>{' '}
          <span className="font-medium text-slate-900">{proposal.expected_impact_metric}</span>
          {proposal.expected_impact_pct_points !== null && (
            <span className="ml-1 font-mono text-emerald-600">
              {proposal.expected_impact_pct_points > 0 ? '+' : ''}
              {proposal.expected_impact_pct_points}pp
            </span>
          )}
        </div>
      )}

      {isPending && (
        <div className="mt-4 space-y-2">
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Rationale (required)"
            rows={2}
            className="w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label={`Rationale for ${proposal.proposal_code}`}
          />
          {error && (
            <p className="text-xs text-rose-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => handleAct('defer')}
              disabled={!rationale.trim() || deferMutation.isPending}
            >
              Defer
            </Button>
            <Button
              variant="danger"
              onClick={() => handleAct('reject')}
              disabled={!rationale.trim() || rejectMutation.isPending}
            >
              Reject
            </Button>
            <Button
              onClick={() => setConfirmAction('approve')}
              disabled={!rationale.trim()}
            >
              Approve…
            </Button>
          </div>
        </div>
      )}

      {!isPending && proposal.decided_by && (
        <p className="mt-3 text-xs text-slate-500">
          Decided by <span className="font-medium text-slate-700">{proposal.decided_by}</span>
          {proposal.pr_ref && (
            <>
              {' · '}
              <a
                href={proposal.pr_ref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-700"
              >
                {proposal.pr_ref}
              </a>
            </>
          )}
        </p>
      )}

      <Modal
        open={confirmAction === 'approve'}
        onClose={() => setConfirmAction(null)}
        title="Approve proposal?"
      >
        <p className="text-sm text-slate-600">
          Approving merges the proposal and creates a new system version. This is reversible only
          via rollback.
        </p>
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          <strong>{proposal.title}</strong>
          <p className="mt-1 text-xs text-slate-600">{rationale}</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmAction(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => handleAct('approve')}
            disabled={approveMutation.isPending}
          >
            {approveMutation.isPending ? 'Approving…' : 'Confirm approve'}
          </Button>
        </div>
      </Modal>
    </article>
  )
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'approved':
      return <Badge color="emerald">Approved</Badge>
    case 'rejected':
      return <Badge color="rose">Rejected</Badge>
    case 'deferred':
      return <Badge color="amber">Deferred</Badge>
    default:
      return <Badge color="slate">{status}</Badge>
  }
}
