/**
 * PendingMutationsPanel — shows outbox-queued mutations with status and
 * resolution UI for permanent failures.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Opened by the OfflineBanner's "View pending" button. Shows:
 *   - Pending / retrying entries (will auto-flush on reconnect)
 *   - Failed entries (permanent 4xx failures requiring operator resolution)
 *   - Per-entry: endpoint, created_at, attempts, last_error
 *   - "Dismiss" button for failed entries (marks as resolved in local outbox)
 *
 * Data flow:
 *   - Polls trpc.outbox.list every 3s when panel is open.
 *   - On dismiss: calls trpc.outbox.dismiss and refetches.
 *   - Updates pendingMutations store so OfflineBanner count stays accurate.
 *
 * Uses Tailwind v4 utility classes only. No mock data.
 */

import { useEffect, useCallback } from 'react'
import { usePendingMutationsPanelStore } from '../../../store/pendingMutationsPanel.js'
import { usePendingMutationsStore } from '../../../store/pendingMutations.js'
import { trpc } from '../../../services/trpc.js'
import type { PendingMutationEntry } from '../../../store/pendingMutations.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status: PendingMutationEntry['status']): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'retrying':
      return 'Retrying'
    case 'failed':
      return 'Failed'
  }
}

function statusClasses(status: PendingMutationEntry['status']): string {
  switch (status) {
    case 'pending':
      return 'bg-blue-50 text-blue-700'
    case 'retrying':
      return 'bg-amber-50 text-amber-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
  }
}

function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ago`
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PendingMutationsPanel() {
  const isOpen = usePendingMutationsPanelStore((s) => s.isOpen)
  const close = usePendingMutationsPanelStore((s) => s.close)
  const setEntries = usePendingMutationsStore((s) => s.setEntries)
  const setLoading = usePendingMutationsStore((s) => s.setLoading)
  const setFetchError = usePendingMutationsStore((s) => s.setFetchError)
  const entries = usePendingMutationsStore((s) => s.entries)
  const isLoading = usePendingMutationsStore((s) => s.isLoading)
  const fetchError = usePendingMutationsStore((s) => s.fetchError)

  // ---------------------------------------------------------------------------
  // Polling via tRPC
  // ---------------------------------------------------------------------------

  const outboxListQuery = trpc.outbox.list.useQuery(undefined, {
    enabled: isOpen,
    refetchInterval: isOpen ? 3_000 : false,
    staleTime: 2_000,
  })

  const dismissMutation = trpc.outbox.dismiss.useMutation({
    onSuccess: () => {
      void outboxListQuery.refetch()
    },
  })

  // Sync query results into the pendingMutations store so other components
  // (e.g., OfflineBanner count) stay accurate.
  useEffect(() => {
    if (outboxListQuery.isLoading) {
      setLoading(true)
      return
    }
    if (outboxListQuery.isError) {
      setFetchError(outboxListQuery.error?.message ?? 'Failed to fetch outbox')
      return
    }
    if (outboxListQuery.data) {
      setEntries(
        outboxListQuery.data.map((row) => ({
          ...row,
          status: row.status as PendingMutationEntry['status'],
        })),
      )
    }
  }, [
    outboxListQuery.data,
    outboxListQuery.isLoading,
    outboxListQuery.isError,
    outboxListQuery.error,
    setEntries,
    setLoading,
    setFetchError,
  ])

  const handleDismiss = useCallback(
    (seq: string) => {
      dismissMutation.mutate({ seq })
    },
    [dismissMutation],
  )

  if (!isOpen) return null

  const pendingEntries = entries.filter((e) => e.status === 'pending' || e.status === 'retrying')
  const failedEntries = entries.filter((e) => e.status === 'failed')

  return (
    // Overlay backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-end bg-black/20 pt-14 pr-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pending mutations"
    >
      {/* Panel */}
      <div className="flex w-96 flex-col rounded-lg border border-slate-200 bg-white shadow-xl max-h-[calc(100vh-4rem)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Pending Changes
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close pending mutations panel"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && entries.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              Loading...
            </div>
          )}

          {fetchError && (
            <div className="px-4 py-3 text-sm text-red-600 bg-red-50 border-b border-red-100">
              Error: {fetchError}
            </div>
          )}

          {!isLoading && entries.length === 0 && !fetchError && (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              No pending changes.
            </div>
          )}

          {pendingEntries.length > 0 && (
            <div>
              <div className="sticky top-0 bg-slate-50 px-4 py-1.5 text-xs font-medium text-slate-500 border-b border-slate-100">
                Will flush on reconnect ({pendingEntries.length})
              </div>
              <ul className="divide-y divide-slate-50">
                {pendingEntries.map((entry) => (
                  <EntryRow key={entry.seq} entry={entry} onDismiss={null} />
                ))}
              </ul>
            </div>
          )}

          {failedEntries.length > 0 && (
            <div>
              <div className="sticky top-0 bg-slate-50 px-4 py-1.5 text-xs font-medium text-red-600 border-b border-slate-100">
                Requires resolution ({failedEntries.length})
              </div>
              <ul className="divide-y divide-slate-50">
                {failedEntries.map((entry) => (
                  <EntryRow
                    key={entry.seq}
                    entry={entry}
                    onDismiss={handleDismiss}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
          Pending changes will automatically flush when the hub reconnects.
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EntryRow sub-component
// ---------------------------------------------------------------------------

interface EntryRowProps {
  entry: PendingMutationEntry
  onDismiss: ((seq: string) => void) | null
}

function EntryRow({ entry, onDismiss }: EntryRowProps) {
  return (
    <li className="flex flex-col gap-1 px-4 py-3 hover:bg-slate-50">
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1 truncate text-xs font-mono text-slate-700">
          {entry.endpoint}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses(entry.status)}`}
        >
          {statusLabel(entry.status)}
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span>{formatRelativeTime(entry.created_at)}</span>
        {entry.attempts > 0 && (
          <span>{entry.attempts} attempt{entry.attempts !== 1 ? 's' : ''}</span>
        )}
      </div>

      {entry.last_error && (
        <p className="text-xs text-red-600 leading-relaxed line-clamp-2" title={entry.last_error}>
          {entry.last_error}
        </p>
      )}

      {onDismiss !== null && (
        <button
          type="button"
          onClick={() => onDismiss(entry.seq)}
          className="mt-1 self-start rounded px-2 py-0.5 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
          aria-label={`Dismiss failed mutation for ${entry.endpoint}`}
        >
          Dismiss
        </button>
      )}
    </li>
  )
}
