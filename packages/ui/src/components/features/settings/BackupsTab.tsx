/**
 * BackupsTab — list of past backup tarballs and their schedule.
 *
 * Calls admin.backup.list. The export operation lives at /admin/backups; this
 * tab is for read-only awareness of cadence and inventory.
 */

import { Link } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${sizes[i]}`
}

export function BackupsTab() {
  const query = trpc.admin.backup.list.useQuery()

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <p className="font-semibold">Backup schedule</p>
        <p className="mt-0.5 text-blue-800">
          Backups run via <code className="font-mono">npm run backup</code> or via the Admin
          Backups view. Snapshots are written to{' '}
          <code className="font-mono">~/.orbital/backup/snapshots/</code> as
          encrypted tarballs.
        </p>
        <Link
          to="/admin/backups"
          className="mt-1 inline-flex items-center text-xs font-semibold text-blue-700 hover:text-blue-900"
        >
          Open Admin Backups →
        </Link>
      </div>

      {query.isLoading ? (
        <Skeleton rows={3} />
      ) : query.error ? (
        <ErrorMessage title="Could not list backups" message={query.error.message} />
      ) : query.data && query.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-xs text-slate-500">
          No backups yet. The first export will appear here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Filename</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
              {(query.data ?? []).map((b) => (
                <tr key={b.path}>
                  <td className="px-4 py-2 font-mono text-xs">{b.filename}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {formatBytes(b.size)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
