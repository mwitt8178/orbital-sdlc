/**
 * hub-admin/InstallsTable.tsx — Table of known hub installs.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Fetches GET /admin/installs, renders in a table with a Revoke action.
 * Revocation fires POST /admin/installs/:id/revoke with confirmation.
 */

import { useEffect, useState, useCallback } from 'react'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'

interface KnownInstall {
  installId: string
  displayName: string | null
  role: 'owner' | 'member'
  publicKey: string
  joinedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

interface Props {
  ownerToken: string | null
}

function RoleBadge({ role }: { role: 'owner' | 'member' }) {
  return role === 'owner' ? (
    <Badge color="violet">Owner</Badge>
  ) : (
    <Badge color="slate">Member</Badge>
  )
}

function RelativeTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-slate-400">—</span>

  const diff = Date.now() - new Date(iso).getTime()
  let label: string

  if (diff < 60_000) {
    label = 'just now'
  } else if (diff < 3_600_000) {
    label = `${Math.floor(diff / 60_000)}m ago`
  } else if (diff < 86_400_000) {
    label = `${Math.floor(diff / 3_600_000)}h ago`
  } else {
    label = new Date(iso).toLocaleDateString()
  }

  return <span title={new Date(iso).toLocaleString()}>{label}</span>
}

export function InstallsTable({ ownerToken }: Props) {
  const [installs, setInstalls] = useState<KnownInstall[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<KnownInstall | null>(null)

  const headers: HeadersInit = ownerToken
    ? { 'x-orbital-owner-token': ownerToken }
    : {}

  const fetchInstalls = useCallback(async () => {
    try {
      const res = await fetch('/admin/installs', { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const json = await res.json() as { installs: KnownInstall[] }
      setInstalls(json.installs)
      setError(null)
    } catch (err) {
      setError((err as Error).message ?? 'Could not load installs')
    } finally {
      setLoading(false)
    }
  }, [ownerToken])

  useEffect(() => {
    void fetchInstalls()
  }, [fetchInstalls])

  const performRevoke = useCallback(
    async (install: KnownInstall) => {
      setRevoking(install.installId)
      setRevokeError(null)

      try {
        const res = await fetch(`/admin/installs/${install.installId}/revoke`, {
          method: 'POST',
          headers,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        // Optimistically update
        setInstalls((prev) =>
          prev
            ? prev.map((i) =>
                i.installId === install.installId
                  ? { ...i, revokedAt: new Date().toISOString() }
                  : i,
              )
            : prev,
        )
        setPendingRevoke(null)
      } catch (err) {
        setRevokeError((err as Error).message ?? 'Revoke failed')
      } finally {
        setRevoking(null)
      }
    },
    [headers],
  )

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (error) {
    return <ErrorMessage message={error} />
  }

  const rows = installs ?? []

  return (
    <div className="space-y-4">
      {revokeError && <ErrorMessage message={revokeError} />}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No installs registered yet. Use an invite token to pair your first laptop.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-600">Name / ID</th>
                <th className="px-4 py-3 font-medium text-slate-600">Role</th>
                <th className="px-4 py-3 font-medium text-slate-600">Joined</th>
                <th className="px-4 py-3 font-medium text-slate-600">Last seen</th>
                <th className="px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="px-4 py-3 font-medium text-slate-600" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((install) => (
                <tr
                  key={install.installId}
                  className={install.revokedAt ? 'bg-rose-50/50 opacity-70' : 'hover:bg-slate-50'}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {install.displayName ?? 'Unnamed install'}
                    </p>
                    <p className="font-mono text-xs text-slate-400">
                      {install.installId.slice(0, 8)}...
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={install.role} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <RelativeTime iso={install.joinedAt} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <RelativeTime iso={install.lastSeenAt} />
                  </td>
                  <td className="px-4 py-3">
                    {install.revokedAt ? (
                      <Badge color="rose">Revoked</Badge>
                    ) : (
                      <Badge color="emerald">Active</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!install.revokedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingRevoke(install)}
                        disabled={revoking === install.installId}
                        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      >
                        {revoking === install.installId ? 'Revoking…' : 'Revoke'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void fetchInstalls()}>
          Refresh
        </Button>
      </div>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void performRevoke(pendingRevoke)
        }}
        title="Revoke install?"
        confirmLabel="Revoke install"
        pendingLabel="Revoking…"
        variant="danger"
        pending={revoking !== null}
        error={revokeError}
        confirmText={pendingRevoke?.displayName ?? pendingRevoke?.installId.slice(0, 8) ?? ''}
        body={
          <p>
            This permanently revokes{' '}
            <span className="font-medium text-slate-900">
              {pendingRevoke?.displayName ?? 'this install'}
            </span>
            . Sessions on that laptop will stop working immediately. This cannot be undone.
          </p>
        }
      />
    </div>
  )
}
