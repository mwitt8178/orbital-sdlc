/**
 * KillButton — capability-gated "Terminate worker" button.
 *
 * Requires admin capability (isAdmin=true) to render the active button.
 * Shows a confirmation dialog before calling admin.workers.kill.
 * Emits WorkerKilledByOperator event (handled server-side by the mutation).
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'

interface KillButtonProps {
  workerId: string
  isAdmin: boolean
  onKilled?: () => void
}

export function KillButton({ workerId, isAdmin, onKilled }: KillButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  const killMutation = trpc.admin.workers.kill.useMutation({
    onSuccess: () => {
      setConfirming(false)
      setReason('')
      onKilled?.()
    },
  })

  if (!isAdmin) {
    return (
      <button
        type="button"
        disabled
        title="Requires admin capability"
        className="cursor-not-allowed rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 opacity-50"
        aria-disabled="true"
      >
        Terminate
      </button>
    )
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        Terminate worker
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3">
      <p className="mb-2 text-xs font-medium text-red-700">
        Are you sure? This will SIGTERM the worker; the task will be marked aborted.
      </p>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="mb-2 w-full rounded border border-red-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-red-400"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => killMutation.mutate({ workerId, reason: reason || 'Operator kill' })}
          disabled={killMutation.isPending}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          {killMutation.isPending ? 'Terminating…' : 'Confirm terminate'}
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setReason('') }}
          className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          Cancel
        </button>
      </div>
      {killMutation.isError && (
        <p className="mt-1 text-xs text-red-600">{killMutation.error.message}</p>
      )}
    </div>
  )
}
