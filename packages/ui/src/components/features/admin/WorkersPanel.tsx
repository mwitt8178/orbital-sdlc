/**
 * WorkersPanel — list active agent workers with kill action.
 *
 * Capability-gated mutation: admin.workers.kill requires the in-memory
 * admin token to be set. If the user has not provided one, the kill
 * button shows a tooltip and is disabled.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Modal } from '../../ui/Modal.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { useAdminToken } from './admin-context.js'

const REFRESH_MS = 5_000

type WorkerStatus = 'connecting' | 'active' | 'idle' | 'terminating' | 'terminated'

function statusBadge(status: WorkerStatus) {
  if (status === 'active') return <Badge color="emerald">active</Badge>
  if (status === 'idle') return <Badge color="amber">idle</Badge>
  if (status === 'connecting') return <Badge color="blue">connecting</Badge>
  if (status === 'terminating') return <Badge color="rose">terminating</Badge>
  return <Badge color="slate">terminated</Badge>
}

export function WorkersPanel() {
  const { token } = useAdminToken()
  const utils = trpc.useUtils()
  const list = trpc.admin.workers.list.useQuery(undefined, {
    refetchInterval: REFRESH_MS,
  })
  const kill = trpc.admin.workers.kill.useMutation({
    onSuccess: () => {
      void utils.admin.workers.list.invalidate()
    },
  })

  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  if (list.isLoading) {
    return <Skeleton className="h-40 w-full" />
  }
  if (list.isError) {
    return <ErrorMessage message={list.error.message ?? 'Could not load workers'} />
  }

  const rows = list.data ?? []

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No workers"
        description="No agent workers are currently registered. They appear here as soon as the orchestrator spawns one."
      />
    )
  }

  const confirming = rows.find((r) => r.workerId === confirmingId) ?? null

  return (
    <>
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-3 font-medium">Persona</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">PID</th>
              <th className="px-5 py-3 font-medium">Started</th>
              <th className="px-5 py-3 font-medium">Last heartbeat</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((w) => (
              <tr key={w.workerId} className="hover:bg-slate-50">
                <td className="px-5 py-3">
                  <div className="font-medium text-slate-900">{w.personaId}</div>
                  <div className="font-mono text-xs text-slate-500">{w.workerId.slice(0, 8)}…</div>
                </td>
                <td className="px-5 py-3">{statusBadge(w.status)}</td>
                <td className="px-5 py-3 font-mono text-xs text-slate-700">
                  {w.pid ?? '—'}
                </td>
                <td className="px-5 py-3 text-xs text-slate-700">
                  {new Date(w.startedAt).toLocaleString()}
                </td>
                <td className="px-5 py-3 text-xs text-slate-700">
                  {w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toLocaleTimeString() : '—'}
                </td>
                <td className="px-5 py-3 text-right">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmingId(w.workerId)}
                    disabled={w.status === 'terminated' || w.status === 'terminating'}
                  >
                    Kill
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!kill.isPending) setConfirmingId(null)
        }}
        title="Kill worker?"
      >
        {confirming && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              Send <span className="font-mono font-semibold">SIGTERM</span> to worker{' '}
              <span className="font-mono">{confirming.personaId}</span>{' '}
              <span className="font-mono text-xs text-slate-500">
                ({confirming.workerId.slice(0, 8)})
              </span>
              ?
            </p>
            <p className="text-xs text-slate-500">
              An <span className="font-mono">AdminWorkerKilled</span> audit event will be emitted.
            </p>

            {kill.isError && (
              <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {kill.error.message}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setConfirmingId(null)}
                disabled={kill.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={kill.isPending}
                onClick={() => {
                  kill.mutate(
                    {
                      workerId: confirming.workerId,
                      reason: 'admin_action',
                      adminToken: token ?? undefined,
                    },
                    {
                      onSuccess: () => {
                        setConfirmingId(null)
                      },
                    },
                  )
                }}
              >
                {kill.isPending ? 'Sending…' : 'Confirm kill'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
