/**
 * store/retros.ts — retro UI selection + transient action state.
 *
 * Authoritative report and proposal data comes from retro.report.get and
 * retro.proposal.list; this store only tracks the user's selected report
 * and the pending action (approve/reject/defer) and its rationale.
 *
 * WS apply methods (called by the WS agent's services/ws.ts):
 *   applyProposalApproved(payload)   — on ProposalApproved WS event
 *   applyProposalRejected(payload)   — on ProposalRejected WS event
 *   applyProposalDeferred(payload)   — on ProposalDeferred WS event
 */

import { create } from 'zustand'

export type ProposalAction = 'approve' | 'reject' | 'defer'

// ---------------------------------------------------------------------------
// WS event payload shapes
// ---------------------------------------------------------------------------

export interface ProposalApprovedPayload {
  proposal_id: string
  report_id: string
  approved_by?: string
  occurred_at?: string
}

export interface ProposalRejectedPayload {
  proposal_id: string
  report_id: string
  reason?: string
  occurred_at?: string
}

export interface ProposalDeferredPayload {
  proposal_id: string
  report_id: string
  deferred_until?: string
  occurred_at?: string
}

// Lightweight proposal state entry for the live cache.
export interface ProposalStateEntry {
  proposalId: string
  reportId: string
  /** 'pending' | 'approved' | 'rejected' | 'deferred' */
  status: 'pending' | 'approved' | 'rejected' | 'deferred'
  decidedAt: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RetrosState {
  selectedReportId: string | null
  pendingProposalId: string | null
  pendingAction: ProposalAction | null
  /** Live proposal state cache updated by WS events. Keyed by proposal_id. */
  proposalStates: Record<string, ProposalStateEntry>
  setSelectedReport: (id: string | null) => void
  beginProposalAction: (proposalId: string, action: ProposalAction) => void
  clearProposalAction: () => void
  /** Called by WS agent on ProposalApproved event. */
  applyProposalApproved: (payload: ProposalApprovedPayload) => void
  /** Called by WS agent on ProposalRejected event. */
  applyProposalRejected: (payload: ProposalRejectedPayload) => void
  /** Called by WS agent on ProposalDeferred event. */
  applyProposalDeferred: (payload: ProposalDeferredPayload) => void
}

export const useRetrosStore = create<RetrosState>((set) => ({
  selectedReportId: null,
  pendingProposalId: null,
  pendingAction: null,
  proposalStates: {},

  setSelectedReport: (id) => set({ selectedReportId: id }),

  beginProposalAction: (proposalId, action) =>
    set({ pendingProposalId: proposalId, pendingAction: action }),

  clearProposalAction: () => set({ pendingProposalId: null, pendingAction: null }),

  applyProposalApproved: (payload) =>
    set((state) => ({
      proposalStates: {
        ...state.proposalStates,
        [payload.proposal_id]: {
          proposalId: payload.proposal_id,
          reportId: payload.report_id,
          status: 'approved',
          decidedAt: payload.occurred_at ?? new Date().toISOString(),
        },
      },
    })),

  applyProposalRejected: (payload) =>
    set((state) => ({
      proposalStates: {
        ...state.proposalStates,
        [payload.proposal_id]: {
          proposalId: payload.proposal_id,
          reportId: payload.report_id,
          status: 'rejected',
          decidedAt: payload.occurred_at ?? new Date().toISOString(),
        },
      },
    })),

  applyProposalDeferred: (payload) =>
    set((state) => ({
      proposalStates: {
        ...state.proposalStates,
        [payload.proposal_id]: {
          proposalId: payload.proposal_id,
          reportId: payload.report_id,
          status: 'deferred',
          decidedAt: payload.occurred_at ?? new Date().toISOString(),
        },
      },
    })),
}))
