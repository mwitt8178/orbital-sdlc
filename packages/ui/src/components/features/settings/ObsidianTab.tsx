/**
 * ObsidianTab — Settings → Integrations → Obsidian.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Shows:
 *   - Feature toggle (server-driven; if ORBITAL_VAULT_ENABLED=off the panel
 *     surfaces a banner explaining how to enable it).
 *   - Mode chooser: "S3-backed (plugin)" vs "Download ZIP".
 *   - "Sync now" button — runs vault.syncProject for the active project.
 *   - "Download vault" button — runs vault.downloadZip + opens the signed URL.
 *   - Last-synced timestamp + entity count.
 *
 * No fakes: every button hits the real tRPC endpoint. If the feature flag
 * is off, mutations surface the real PRECONDITION_FAILED error.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Button } from '../../ui/Button.js'

type SyncMode = 's3' | 'zip'

export function ObsidianTab() {
  const projectId = useActiveProjectStore((s) => s.activeProjectId)
  const [mode, setMode] = useState<SyncMode>('s3')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const status = trpc.vault.status.useQuery(
    { projectId: projectId ?? '00000000-0000-0000-0000-000000000000' },
    { enabled: typeof projectId === 'string' && projectId.length > 0 },
  )

  const syncProject = trpc.vault.syncProject.useMutation()
  const downloadZip = trpc.vault.downloadZip.useMutation()

  const enabled = status.data?.enabled ?? false
  const lastSyncedAt = status.data?.lastSyncedAt ?? null
  const entityCount = status.data?.entityCount ?? 0

  async function handleSync() {
    if (!projectId) {
      setMessage({ kind: 'error', text: 'Choose an active project first.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await syncProject.mutateAsync({ projectId })
      setMessage({
        kind: 'ok',
        text: `Synced ${result.writtenCount}/${result.entityCount} entities to vault.`,
      })
      await status.refetch()
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Sync failed',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload() {
    if (!projectId) {
      setMessage({ kind: 'error', text: 'Choose an active project first.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await downloadZip.mutateAsync({ projectId })
      // Real download: open the signed URL in a new tab.
      window.open(result.url, '_blank', 'noopener,noreferrer')
      setMessage({
        kind: 'ok',
        text: `Built vault (${result.entityCount} entities) — download starting.`,
      })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Download failed',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-slate-900">Obsidian vault sync</h3>
        <p className="mt-1 text-sm text-slate-600">
          Project this project&apos;s visions, epics, stories, ACs, retros, and memory entries into
          a Markdown vault you can open in Obsidian. Source aggregates remain authoritative — the
          vault is a one-way projection (round-trip from vault back to Orbital lands in v2).
        </p>
      </div>

      {!enabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Vault sync is disabled on this server. Set <code>ORBITAL_VAULT_ENABLED=on</code> and
          ensure the api-lambda has <code>ORBITAL_VAULT_BUCKET</code> configured.
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Status</p>
            <p className="mt-1 text-sm text-slate-600">
              {lastSyncedAt
                ? `Last synced ${new Date(lastSyncedAt).toLocaleString()} — ${entityCount} entities tracked.`
                : 'Never synced for this project.'}
            </p>
          </div>
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${
              enabled ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
            aria-hidden
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-900">Sync mode</legend>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
          <input
            type="radio"
            name="vault-mode"
            value="s3"
            checked={mode === 's3'}
            onChange={() => setMode('s3')}
            className="mt-0.5"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-900">S3-backed (recommended)</span>
            <span className="block text-slate-600">
              Push to a tenant-scoped S3 prefix. The Obsidian plugin pulls from there and keeps
              your local vault in sync.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
          <input
            type="radio"
            name="vault-mode"
            value="zip"
            checked={mode === 'zip'}
            onChange={() => setMode('zip')}
            className="mt-0.5"
          />
          <span className="text-sm">
            <span className="font-medium text-slate-900">Download ZIP</span>
            <span className="block text-slate-600">
              Build a ZIP of the vault and open a 15-minute signed URL. Use this if you manage
              your own vault and don&apos;t want the plugin.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        {mode === 's3' ? (
          <Button onClick={handleSync} disabled={busy || !projectId || !enabled}>
            {busy ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : (
          <Button onClick={handleDownload} disabled={busy || !projectId || !enabled}>
            {busy ? 'Building…' : 'Download vault'}
          </Button>
        )}
      </div>

      {message && (
        <div
          className={`rounded-md border p-3 text-sm ${
            message.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
        >
          {message.text}
        </div>
      )}
    </div>
  )
}
