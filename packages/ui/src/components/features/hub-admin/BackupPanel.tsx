/**
 * hub-admin/BackupPanel.tsx — Hub backup management panel.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Renders:
 *   - List of existing backups from GET /admin/backup/status
 *   - "Trigger backup now" button → POST /admin/backup
 *
 * Restore: surfaced as a UI hint; actual restore runs hub-restore.sh
 * server-side (not triggered from the browser for safety).
 */

import { useEffect, useState, useCallback } from 'react'
import { Button } from '../../ui/Button.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'

interface BackupEntry {
  filename: string
  path: string
  sizeBytes: number
  createdAt: string
}

interface Props {
  ownerToken: string | null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BackupPanel({ ownerToken }: Props) {
  const [backups, setBackups] = useState<BackupEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)
  const [triggerResult, setTriggerResult] = useState<{
    filename: string
    sizeBytes: number
    triggeredAt: string
  } | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)

  const headers: HeadersInit = ownerToken
    ? { 'x-orbital-owner-token': ownerToken }
    : {}

  const fetchBackups = useCallback(async () => {
    try {
      const res = await fetch('/admin/backup/status', { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const json = await res.json() as { backups: BackupEntry[] }
      setBackups(json.backups)
      setError(null)
    } catch (err) {
      setError((err as Error).message ?? 'Could not load backup status')
    } finally {
      setLoading(false)
    }
  }, [ownerToken])

  useEffect(() => {
    void fetchBackups()
  }, [fetchBackups])

  const handleTriggerBackup = useCallback(async () => {
    if (!window.confirm('Trigger a new backup now? This may take a few minutes.')) return

    setTriggering(true)
    setTriggerError(null)
    setTriggerResult(null)

    try {
      const res = await fetch('/admin/backup', {
        method: 'POST',
        headers,
      })
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } }
        throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      }
      const result = await res.json() as {
        filename: string
        sizeBytes: number
        triggeredAt: string
      }
      setTriggerResult(result)
      // Refresh the backup list
      await fetchBackups()
    } catch (err) {
      setTriggerError((err as Error).message ?? 'Backup trigger failed')
    } finally {
      setTriggering(false)
    }
  }, [headers, fetchBackups])

  return (
    <div className="space-y-6">
      {/* Trigger section */}
      <section
        aria-label="Trigger backup"
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Manual backup</h3>
            <p className="mt-1 text-sm text-slate-500">
              Triggers hub-backup.sh: pg_dump, gzip, AES-256-CBC encrypt with hub master key.
            </p>
          </div>
          <Button
            onClick={() => void handleTriggerBackup()}
            disabled={triggering}
            variant="primary"
            size="sm"
          >
            {triggering ? 'Backing up…' : 'Trigger backup now'}
          </Button>
        </div>

        {triggerResult && (
          <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            Backup triggered: <span className="font-mono">{triggerResult.filename}</span>{' '}
            ({formatBytes(triggerResult.sizeBytes)}) at{' '}
            {new Date(triggerResult.triggeredAt).toLocaleTimeString()}
          </div>
        )}

        {triggerError && (
          <div className="mt-4">
            <ErrorMessage message={triggerError} />
          </div>
        )}
      </section>

      {/* Restore note */}
      <section
        aria-label="Restore instructions"
        className="rounded-lg border border-amber-200 bg-amber-50 p-4"
      >
        <h3 className="text-sm font-semibold text-amber-900">Restore</h3>
        <p className="mt-1 text-sm text-amber-800">
          Restore is a server-side operation. SSH into your hub host and run:
        </p>
        <pre className="mt-2 rounded bg-amber-100 px-3 py-2 text-xs text-amber-900">
          bash scripts/hub-restore.sh --backup=./backups/&lt;filename&gt;
        </pre>
        <p className="mt-2 text-xs text-amber-700">
          See docs/hub-deployment.md for the full restore procedure.
        </p>
      </section>

      {/* Backup list */}
      <section aria-label="Backup history">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Backup history</h3>
          <Button variant="ghost" size="sm" onClick={() => void fetchBackups()}>
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <ErrorMessage message={error} />
        ) : !backups || backups.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No backups found. Trigger a backup to get started.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-2 font-medium text-slate-600">Filename</th>
                  <th className="px-4 py-2 font-medium text-slate-600">Size</th>
                  <th className="px-4 py-2 font-medium text-slate-600">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {backups.map((backup) => (
                  <tr key={backup.filename} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-900">
                      {backup.filename}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {formatBytes(backup.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {new Date(backup.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
