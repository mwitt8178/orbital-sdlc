/**
 * store/hub.ts — Zustand store for hub connection state.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */

import { create } from 'zustand'

export type HubConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface HubState {
  status: HubConnectionStatus
  hubUrl: string | null
  lastSyncAt: string | null
  errorMessage: string | null

  // Actions
  setStatus: (status: HubConnectionStatus) => void
  setHubUrl: (url: string | null) => void
  setLastSyncAt: (at: string) => void
  setErrorMessage: (msg: string | null) => void
  /** Full update from a server health check. */
  applyHubStatus: (update: {
    status: HubConnectionStatus
    hubUrl: string | null
    lastSyncAt: string | null
    errorMessage: string | null
  }) => void
}

export const useHubStore = create<HubState>((set) => ({
  status: 'disconnected',
  hubUrl: null,
  lastSyncAt: null,
  errorMessage: null,

  setStatus: (status) => set({ status }),
  setHubUrl: (hubUrl) => set({ hubUrl }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),

  applyHubStatus: (update) =>
    set({
      status: update.status,
      hubUrl: update.hubUrl,
      lastSyncAt: update.lastSyncAt,
      errorMessage: update.errorMessage,
    }),
}))
