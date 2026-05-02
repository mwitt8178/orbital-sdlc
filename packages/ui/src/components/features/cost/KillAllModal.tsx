/**
 * KillAllModal — confirmation dialog for the hard kill switch.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'

interface KillAllModalProps {
  scope: 'install' | 'project' | 'sprint'
  scopeId: string
  scopeLabel: string
  onClose: () => void
  onKilled?: (workerIds: string[]) => void
}

export function KillAllModal({ scope, scopeId, scopeLabel, onClose, onKilled }: KillAllModalProps) {
  const [reason, setReason] = useState('operator_kill_switch')
  const [confirmed, setConfirmed] = useState(false)

  const killAll = trpc.cost.killAll.useMutation({
    onSuccess: (data) => {
      onKilled?.(data.killedWorkerIds)
      onClose()
    },
  })

  const canSubmit = confirmed && reason.trim().length > 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kill-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#dc2626"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <h2 id="kill-modal-title" className="text-base font-semibold text-slate-900">
              Kill all workers
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              This will send SIGTERM to every active worker in{' '}
              <strong>{scope}: {scopeLabel}</strong>. This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="mb-4 space-y-3">
          <div>
            <label htmlFor="kill-reason" className="mb-1 block text-xs font-medium text-slate-700">
              Reason (required)
            </label>
            <input
              id="kill-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={256}
              placeholder="e.g. budget_exceeded, emergency_stop"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="rounded border-slate-300 text-red-600 focus:ring-red-400"
            />
            I understand this will terminate all running agent workers in this scope.
          </label>
        </div>

        {killAll.isError && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {killAll.error.message}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            disabled={!canSubmit || killAll.isPending}
            onClick={() => {
              killAll.mutate({ scope, scopeId, reason: reason.trim() })
            }}
            className="flex-1 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {killAll.isPending ? 'Killing…' : 'Kill all workers'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
