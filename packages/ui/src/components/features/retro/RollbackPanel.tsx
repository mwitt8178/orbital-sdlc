/**
 * RollbackPanel — list past system_versions and roll the agent-org config
 * back to a chosen version.
 *
 * The retro.rollback mutation creates a new system_version row whose parent is
 * the version being rolled back to and produces a fresh git tag/sha. The
 * agent-org repo is updated; the next sprint runs against this configuration.
 *
 * UX:
 *   - Versions table sorted newest first (matches Retro page sort).
 *   - "Rollback to this version" opens a confirmation modal showing version
 *     metadata and asking for a rationale.
 *   - On success, toasts and invalidates the versions query.
 *   - If a row in the table already has is_rollback=true we mark it visually.
 *   - Checks the most-recent row to decide whether a rollback is in flight
 *     (i.e. the latest mutation has not yet been observed by the next sprint).
 */

import { useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { Modal } from '../../ui/Modal.js'
import { useToast } from '../../../services/use-toast.js'

interface SystemVersionRow {
  system_version_id: string
  version_number: string | number
  parent_system_version_id: string | null
  git_tag: string | null
  git_sha: string | null
  shipped_at: string
  shipped_by: string | null
  is_rollback: boolean
  rolled_back_version_id: string | null
  retro_report_id: string | null
}

export function RollbackPanel() {
  const utils = trpc.useUtils()
  const versionsQuery = trpc.retro.versions.list.useQuery()
  const toast = useToast()
  const [target, setTarget] = useState<SystemVersionRow | null>(null)
  const [rationale, setRationale] = useState('')
  const [confirmDependents, setConfirmDependents] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState('user-default')

  const mutation = trpc.retro.rollback.useMutation({
    onSuccess: (data) => {
      toast.success('Rollback complete', {
        description: `New system version ${data.git_tag ?? data.git_sha?.slice(0, 7) ?? ''}`.trim(),
      })
      setTarget(null)
      setRationale('')
      setConfirmDependents(false)
      void utils.retro.versions.list.invalidate()
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Rollback failed', { description: err.message })
    },
  })

  const versions = useMemo<SystemVersionRow[]>(() => {
    const raw = (versionsQuery.data ?? []) as SystemVersionRow[]
    return [...raw].sort((a, b) => (a.shipped_at < b.shipped_at ? 1 : -1))
  }, [versionsQuery.data])

  const inFlight = mutation.isPending

  if (versionsQuery.isLoading) {
    return <Skeleton rows={4} />
  }
  if (versionsQuery.error) {
    return (
      <ErrorMessage
        title="Could not load system versions"
        message={versionsQuery.error.message}
      />
    )
  }

  if (versions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
        <h3 className="text-sm font-semibold text-slate-900">No system versions yet</h3>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
          A row is added each time a sprint completes and proposals merge. Once you have at
          least one prior version you will be able to roll back here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {inFlight ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Rollback in progress…
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Version</th>
              <th className="px-4 py-2 text-left font-medium">Shipped at</th>
              <th className="px-4 py-2 text-left font-medium">Shipped by</th>
              <th className="px-4 py-2 text-left font-medium">Tag · SHA</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
            {versions.map((v, i) => {
              const isHead = i === 0
              return (
                <tr key={v.system_version_id}>
                  <td className="px-4 py-2 font-mono text-xs">
                    v{v.version_number}
                    {isHead ? (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                        head
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {new Date(v.shipped_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {v.shipped_by ?? '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <div className="text-slate-700">{v.git_tag ?? '—'}</div>
                    <div className="text-slate-400">
                      {v.git_sha ? v.git_sha.slice(0, 12) : '—'}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {v.is_rollback ? (
                      <Badge color="amber">Rollback</Badge>
                    ) : (
                      <Badge color="indigo">Forward</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant={isHead ? 'secondary' : 'primary'}
                      disabled={isHead || inFlight}
                      onClick={() => {
                        setTarget(v)
                        setError(null)
                      }}
                    >
                      {isHead ? 'Current' : 'Rollback to this'}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Modal
        open={target !== null}
        onClose={() => {
          setTarget(null)
          setRationale('')
          setConfirmDependents(false)
        }}
        title="Confirm rollback"
        width="max-w-xl"
      >
        {target ? (
          <div className="space-y-4 text-sm">
            <p className="text-slate-600">
              This reverts the agent-org repo to{' '}
              <span className="font-mono text-slate-900">v{target.version_number}</span> (
              <span className="font-mono text-xs text-slate-500">
                {target.git_tag ?? target.git_sha?.slice(0, 12) ?? target.system_version_id.slice(0, 8)}
              </span>
              ). The next sprint will run against this configuration.
            </p>
            <div>
              <label
                className="block text-xs font-medium text-slate-700"
                htmlFor="rollback-rationale"
              >
                Rationale (required)
              </label>
              <textarea
                id="rollback-rationale"
                rows={3}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Why are you rolling back?"
              />
            </div>
            <div>
              <label
                className="block text-xs font-medium text-slate-700"
                htmlFor="rollback-user-id"
              >
                Approved by (user id)
              </label>
              <input
                id="rollback-user-id"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="user-default"
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={confirmDependents}
                onChange={(e) => setConfirmDependents(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand any proposals shipped <em>after</em> this version may be implicitly
                reverted.
              </span>
            </label>
            {error ? (
              <p className="text-xs text-rose-600" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setTarget(null)
                  setRationale('')
                  setConfirmDependents(false)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!rationale.trim() || !userId.trim() || mutation.isPending}
                onClick={() => {
                  if (!target) return
                  setError(null)
                  mutation.mutate({
                    rolled_back_system_version_id: target.system_version_id,
                    rationale: rationale.trim(),
                    user_id: userId.trim(),
                    confirm_with_dependents: confirmDependents,
                  })
                }}
              >
                {mutation.isPending ? 'Rolling back…' : 'Confirm rollback'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
