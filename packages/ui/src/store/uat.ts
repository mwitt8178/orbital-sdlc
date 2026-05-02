/**
 * store/uat.ts — UAT session state.
 *
 * Holds the currently-selected ticket and session id so views can subscribe.
 * Authoritative AC results come from uat.session.get; this store just tracks
 * the user's current selection and pending observed-behavior text per AC.
 *
 * WS apply methods (called by the WS agent's services/ws.ts):
 *   applyDefectCreated(payload)    — on DefectCreated WS event
 *   applyDefectReopened(payload)   — on DefectReopened WS event
 *   applySessionStateChanged(payload) — on UATSessionStateChanged WS event
 */

import { create } from 'zustand'

export type ACStatus = 'pending' | 'pass' | 'fail'

// ---------------------------------------------------------------------------
// WS event payload shapes
// ---------------------------------------------------------------------------

export interface DefectCreatedPayload {
  defect_id: string
  defect_key: string
  title: string
  severity: string
  state: string
  origin_story_id: string
  persona_of_record_id: string | null
  ac_id: string | null
  session_id: string | null
  occurred_at?: string
}

export interface DefectReopenedPayload {
  defect_id: string
  defect_key?: string
  occurred_at?: string
}

export interface UATSessionStateChangedPayload {
  uat_session_id: string
  ticket_id: string
  new_state: string
  occurred_at?: string
}

// Lightweight defect entry for the store (not the full tRPC shape).
export interface DefectEntry {
  defectId: string
  defectKey: string
  title: string
  severity: string
  state: string
  originStoryId: string
  personaOfRecordId: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface UATState {
  selectedTicketId: string | null
  selectedSessionId: string | null
  /** observed behavior typed by the user, keyed by AC id; cleared on submit. */
  draftObservedBehavior: Record<string, string>
  /**
   * Live defect cache updated by WS events. Keyed by defect_id.
   * The DefectList component primarily reads from tRPC; this is an optimistic
   * supplement so newly-created defects appear before a re-fetch.
   */
  defectCache: Record<string, DefectEntry>
  setSelectedTicket: (id: string | null) => void
  setSelectedSession: (id: string | null) => void
  setDraftObservedBehavior: (acId: string, body: string) => void
  clearDrafts: () => void
  /** Called by WS agent on DefectCreated event. */
  applyDefectCreated: (payload: DefectCreatedPayload) => void
  /** Called by WS agent on DefectReopened event. */
  applyDefectReopened: (payload: DefectReopenedPayload) => void
  /** Called by WS agent on UATSessionStateChanged event. */
  applySessionStateChanged: (payload: UATSessionStateChangedPayload) => void
}

export const useUATStore = create<UATState>((set) => ({
  selectedTicketId: null,
  selectedSessionId: null,
  draftObservedBehavior: {},
  defectCache: {},

  setSelectedTicket: (id) => set({ selectedTicketId: id }),
  setSelectedSession: (id) => set({ selectedSessionId: id }),
  setDraftObservedBehavior: (acId, body) =>
    set((state) => ({
      draftObservedBehavior: { ...state.draftObservedBehavior, [acId]: body },
    })),
  clearDrafts: () => set({ draftObservedBehavior: {} }),

  applyDefectCreated: (payload) =>
    set((state) => ({
      defectCache: {
        ...state.defectCache,
        [payload.defect_id]: {
          defectId: payload.defect_id,
          defectKey: payload.defect_key,
          title: payload.title,
          severity: payload.severity,
          state: payload.state,
          originStoryId: payload.origin_story_id,
          personaOfRecordId: payload.persona_of_record_id,
        },
      },
    })),

  applyDefectReopened: (payload) =>
    set((state) => {
      const existing = state.defectCache[payload.defect_id]
      if (!existing) return state
      return {
        defectCache: {
          ...state.defectCache,
          [payload.defect_id]: { ...existing, state: 'open' },
        },
      }
    }),

  applySessionStateChanged: (_payload) => {
    // Intentionally no local state mutation; the component re-fetches
    // from tRPC on invalidation. This hook exists so the WS agent can
    // trigger tRPC cache invalidation via React Query utils externally.
    // No-op here — consumers subscribe to tRPC staleTime instead.
  },
}))
