/**
 * KeysPanel — list signing keys + key history; rotate active sub-key.
 *
 * Capability-gated mutation: admin.keys.rotate.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Modal } from '../../ui/Modal.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { useAdminToken } from './admin-context.js'

function statusBadge(status: 'active' | 'retired' | 'archived' | 'compromised') {
  if (status === 'active') return <Badge color="emerald">active</Badge>
  if (status === 'retired') return <Badge color="amber">retired</Badge>
  if (status === 'archived') return <Badge color="slate">archived</Badge>
  return <Badge color="rose">compromised</Badge>
}

export function KeysPanel() {
  const { token } = useAdminToken()
  const utils = trpc.useUtils()
  const data = trpc.admin.keys.history.useQuery(undefined, {
    refetchInterval: 30_000,
  })
  const rotate = trpc.admin.keys.rotate.useMutation({
    onSuccess: () => {
      void utils.admin.keys.history.invalidate()
    },
  })

  const [confirming, setConfirming] = useState(false)

  if (data.isLoading) {
    return <Skeleton className="h-40 w-full" />
  }
  if (data.isError) {
    return <ErrorMessage message={data.error.message ?? 'Could not load keys'} />
  }

  const keys = data.data?.keys ?? []
  const history = data.data?.history ?? []

  const masters = keys.filter((k) => k.keyKind === 'master')
  const subs = keys.filter((k) => k.keyKind === 'sub')

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Signing keys</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Two-tier Ed25519 hierarchy. Private bytes live in the OS keychain, never Postgres.
          </p>
        </div>
        <Button onClick={() => setConfirming(true)} disabled={subs.length === 0}>
          Rotate active sub-key
        </Button>
      </header>

      <section
        aria-label="Master keys"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <header className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Master keys</h3>
        </header>
        {masters.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No master keys recorded.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Key ID</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3 font-medium">Active until</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {masters.map((k) => (
                <tr key={k.keyId}>
                  <td className="px-5 py-3 font-mono text-xs text-slate-700">{k.keyId}</td>
                  <td className="px-5 py-3">{statusBadge(k.status)}</td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {new Date(k.createdAt).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {k.activeUntil ? new Date(k.activeUntil).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        aria-label="Sub-keys"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <header className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Sub-keys (per sprint)</h3>
        </header>
        {subs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            No sub-keys yet. The first sprint start will generate one.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Key ID</th>
                <th className="px-5 py-3 font-medium">Sprint</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Active from</th>
                <th className="px-5 py-3 font-medium">Zeroized</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subs.map((k) => (
                <tr key={k.keyId}>
                  <td className="px-5 py-3 font-mono text-xs text-slate-700">{k.keyId.slice(0, 12)}…</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-700">
                    {k.sprintId?.slice(0, 12) ?? '—'}…
                  </td>
                  <td className="px-5 py-3">{statusBadge(k.status)}</td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {new Date(k.activeFrom).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {k.privateZeroizedAt ? new Date(k.privateZeroizedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        aria-label="Recent transitions"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <header className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Recent transitions</h3>
        </header>
        {history.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No key transitions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {history.slice(0, 20).map((h) => (
              <li key={h.historyId} className="flex items-center justify-between px-5 py-2">
                <div className="flex items-center gap-3">
                  <Badge color="indigo">{h.transition}</Badge>
                  <span className="font-mono text-xs text-slate-700">
                    {h.keyId.slice(0, 12)}…
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {new Date(h.transitionAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={confirming}
        onClose={() => {
          if (!rotate.isPending) setConfirming(false)
        }}
        title="Rotate sub-key?"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Rotation retires the current active sub-key, generates a new one, and emits a{' '}
            <span className="font-mono">KeyRotated</span> audit event. Capabilities issued
            against the retired key remain verifiable.
          </p>
          {rotate.isError && (
            <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {rotate.error.message}
            </p>
          )}
          {rotate.data && (
            <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              Rotated. New key{' '}
              <span className="font-mono">{rotate.data.newKeyId.slice(0, 12)}…</span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={rotate.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={rotate.isPending}
              onClick={() => {
                rotate.mutate({ adminToken: token ?? undefined })
              }}
            >
              {rotate.isPending ? 'Rotating…' : 'Confirm rotate'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
