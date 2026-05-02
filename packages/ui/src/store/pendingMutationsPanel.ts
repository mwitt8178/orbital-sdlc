/**
 * store/pendingMutationsPanel.ts — Zustand store for PendingMutationsPanel
 * open/close state.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Simple open/close signal. OfflineBanner calls open(); PendingMutationsPanel
 * reads isOpen and calls close() on dismiss.
 */

import { create } from 'zustand'

export interface PendingMutationsPanelState {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

export const usePendingMutationsPanelStore = create<PendingMutationsPanelState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}))
