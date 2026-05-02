/**
 * store/pendingMutations.ts — Zustand store for outbox-queued mutation state.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * This store tracks:
 *   - List of pending/retrying/failed outbox entries (polled from the
 *     local orchestrator's /trpc/outbox.list endpoint).
 *   - pendingCount / failedCount for display in OfflineBanner and
 *     useHubConnection.
 *   - Refresh state for the PendingMutationsPanel.
 *
 * Polling is initiated by PendingMutationsPanel or OfflineBanner (whichever
 * mounts first when isDown=true). Polling stops when the hub reconnects.
 *
 * Entry statuses mirror the backend OutboxEntryStatus:
 *   - 'pending': not yet attempted
 *   - 'retrying': attempted at least once, not yet exhausted
 *   - 'failed': permanently failed (4xx or attempts >= maxRetries)
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingEntryStatus = 'pending' | 'retrying' | 'failed'

export interface PendingMutationEntry {
  /** Outbox sequence number (bigint as string for JSON compat). */
  seq: string
  kind: 'event' | 'mutation'
  endpoint: string
  idempotency_key: string
  created_at: string
  attempts: number
  last_error: string | null
  status: PendingEntryStatus
}

export interface PendingMutationsState {
  entries: PendingMutationEntry[]
  pendingCount: number
  failedCount: number
  isLoading: boolean
  lastFetchedAt: string | null
  fetchError: string | null

  // Actions
  setEntries: (entries: PendingMutationEntry[]) => void
  setLoading: (v: boolean) => void
  setFetchError: (msg: string | null) => void
  clear: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePendingMutationsStore = create<PendingMutationsState>((set) => ({
  entries: [],
  pendingCount: 0,
  failedCount: 0,
  isLoading: false,
  lastFetchedAt: null,
  fetchError: null,

  setEntries: (entries) =>
    set({
      entries,
      pendingCount: entries.filter((e) => e.status === 'pending' || e.status === 'retrying').length,
      failedCount: entries.filter((e) => e.status === 'failed').length,
      lastFetchedAt: new Date().toISOString(),
      fetchError: null,
    }),

  setLoading: (v) => set({ isLoading: v }),

  setFetchError: (msg) => set({ fetchError: msg, isLoading: false }),

  clear: () =>
    set({
      entries: [],
      pendingCount: 0,
      failedCount: 0,
      fetchError: null,
      lastFetchedAt: null,
    }),
}))
