/**
 * store/disagreements.ts — active disagreement state derived from WS events.
 *
 * Holds active disagreements and their resolution state. The WS agent's
 * services/ws.ts will call the apply* methods below on incoming WS events.
 *
 * Methods the WS agent should wire:
 *   applyDisagreementRaised(payload)  — on DisagreementRaised event
 *   applyTieBreakerDecided(payload)   — on TieBreakerDecided event
 *   applyADRPublished(payload)        — on ADRPublished event
 */

import { create } from 'zustand'

export interface Disagreement {
  disagreementId: string
  topic: string
  channelId: string
  tieBreakerPersona: string | null
  adrId: string | null
  /** 'active' until tie-breaker decides; 'resolved' once ADR published */
  status: 'active' | 'decided' | 'resolved'
  raisedAt: string
  decidedAt: string | null
  resolvedAt: string | null
}

// ---------------------------------------------------------------------------
// WS event payload shapes (the WS agent will pass these in)
// ---------------------------------------------------------------------------

export interface DisagreementRaisedPayload {
  disagreement_id: string
  topic: string
  channel_id: string
  raised_at?: string
  occurred_at?: string
}

export interface TieBreakerDecidedPayload {
  disagreement_id: string
  tie_breaker_persona: string
  decided_at?: string
  occurred_at?: string
}

export interface ADRPublishedPayload {
  disagreement_id?: string
  adr_id: string
  published_at?: string
  occurred_at?: string
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DisagreementsState {
  active: Disagreement[]
  applyDisagreementRaised: (payload: DisagreementRaisedPayload) => void
  applyTieBreakerDecided: (payload: TieBreakerDecidedPayload) => void
  applyADRPublished: (payload: ADRPublishedPayload) => void
}

export const useDisagreementsStore = create<DisagreementsState>((set) => ({
  active: [],

  applyDisagreementRaised: (payload) =>
    set((state) => {
      // Idempotent: skip if already known.
      if (state.active.some((d) => d.disagreementId === payload.disagreement_id)) return state
      const entry: Disagreement = {
        disagreementId: payload.disagreement_id,
        topic: payload.topic,
        channelId: payload.channel_id,
        tieBreakerPersona: null,
        adrId: null,
        status: 'active',
        raisedAt: payload.raised_at ?? payload.occurred_at ?? new Date().toISOString(),
        decidedAt: null,
        resolvedAt: null,
      }
      return { active: [...state.active, entry] }
    }),

  applyTieBreakerDecided: (payload) =>
    set((state) => ({
      active: state.active.map((d) =>
        d.disagreementId === payload.disagreement_id
          ? {
              ...d,
              status: 'decided' as const,
              tieBreakerPersona: payload.tie_breaker_persona,
              decidedAt: payload.decided_at ?? payload.occurred_at ?? new Date().toISOString(),
            }
          : d,
      ),
    })),

  applyADRPublished: (payload) =>
    set((state) => ({
      active: state.active.map((d) =>
        payload.disagreement_id && d.disagreementId === payload.disagreement_id
          ? {
              ...d,
              status: 'resolved' as const,
              adrId: payload.adr_id,
              resolvedAt: payload.published_at ?? payload.occurred_at ?? new Date().toISOString(),
            }
          : d,
      ),
    })),
}))
