/**
 * BackupsPanel — list past backups; trigger a new export.
 *
 * Backups live under <orbital_home>/backup/snapshots/ as encrypted .tar.enc
 * tarballs. The list endpoint is filesystem-driven (we don't keep a
 * dedicated table for v1) so the only metadata is filename, size, ctime.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Input } from '../../ui/Input.js'
import { Modal } from '../../ui/Modal.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { useAdminToken } from './admin-context.js'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function BackupsPanel() {
  const { token } = useAdminToken()
  const utils = trpc.useUtils()
  const list = trpc.admin.backup.list.useQuery(undefined, { refetchInterval: 30_000 })
  const exportMutation = trpc.admin.backup.export.useMutation({
    onSuccess: () => {
      void utils.admin.backup.list.invalidate()
    },
  })

  const [open, setOpen] = useState(false)
  const [passphrase, setPassphrase] = useState('')

  const rows = list.data ?? []

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Backups</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Encrypted tarballs containing pg_dump output, keychain entries, and install.json.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>Run backup now</Button>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        {list.isLoading ? (
          <div className="p-5">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : list.isError ? (
          <ErrorMessage message={list.error.message ?? 'Could not load backups'} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No backups yet"
            description="Click Run backup now to produce your first encrypted tarball."
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Filename</th>
                <th className="px-5 py-3 font-medium">Size</th>
                <th className="px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3 font-medium">Path</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((b) => (
                <tr key={b.path}>
                  <td className="px-5 py-3 font-medium text-slate-900">{b.filename}</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-700">
                    {formatBytes(b.size)}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-700">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 break-all font-mono text-[11px] text-slate-500">
                    {b.path}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={open}
        onClose={() => {
          if (!exportMutation.isPending) {
            setOpen(false)
            setPassphrase('')
          }
        }}
        title="Run backup"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Provide an encryption passphrase. If left blank, the keychain entry{' '}
            <span className="font-mono">backup.passphrase</span> is used. You will need this
            passphrase to restore from the resulting tarball.
          </p>

          <div>
            <label htmlFor="bp" className="mb-1 block text-xs font-medium text-slate-700">
              Passphrase (optional — falls back to keychain or env)
            </label>
            <Input
              id="bp"
              type="password"
              value={passphrase}
              autoComplete="new-password"
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Leave blank to use keychain"
            />
          </div>

          {exportMutation.isError && (
            <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {exportMutation.error.message}
            </p>
          )}

          {exportMutation.data && (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <p className="font-medium">Backup written</p>
              <p className="mt-0.5 break-all font-mono">{exportMutation.data.outPath}</p>
              <p className="mt-0.5">{formatBytes(exportMutation.data.size)}</p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false)
                setPassphrase('')
              }}
              disabled={exportMutation.isPending}
            >
              Close
            </Button>
            <Button
              disabled={exportMutation.isPending}
              onClick={() => {
                exportMutation.mutate({
                  adminToken: token ?? undefined,
                  passphrase: passphrase.length > 0 ? passphrase : undefined,
                })
              }}
            >
              {exportMutation.isPending ? 'Backing up…' : 'Run backup'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
