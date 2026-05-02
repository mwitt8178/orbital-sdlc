/**
 * store/ceremonies.ts — active-ceremony state derived from WS events.
 *
 * No tRPC list endpoint exists for ceremonies in the current AppRouter
 * (per Phase 7 architecture); the UI relies entirely on WS-stream events
 * to populate this store. When no ceremony is live the store renders empty.
 *
 * Round 5 additions:
 *   - CeremonyTrigger — optional trigger metadata on each ceremony. Populated
 *     when ceremony.list eventually returns trigger info from the
 *     ceremony_trigger_firings table (backend agent scope). Until then, any
 *     ceremony without a trigger field falls back to "Manual" in the UI.
 *   - list — ordered array of all ceremonies (scheduled / in_progress / closed)
 *     for the Ceremonies page list view.
 *   - setList / upsertCeremony — list mutation helpers.
 */

import { create } from 'zustand'

export interface CeremonyParticipant {
  personaRole: string
  /** Tokens spent so far in this ceremony. */
  tokensConsumed: number
  /** Tokens remaining in budget. */
  tokensRemaining: number
  /** True when this participant is currently taking a turn. */
  isCurrentTurn: boolean
}

/**
 * Trigger metadata returned by ceremony.list once the backend agent wires
 * ceremony_trigger_firings. Until then this field is absent and the UI
 * renders the "Manual" fallback chip.
 *
 * DEFERRED: wiring ceremony.list to return trigger info is the backend
 * agent's responsibility (CeremonyScheduler agent). When the procedure
 * exists, WS handlers or a tRPC query should populate this field.
 */
export interface CeremonyTrigger {
  /** rule_id from ceremony_trigger_rules e.g. "backlog-grooming" */
  rule_id: string
  /** trigger_event_id that fired the rule */
  trigger_event_id: string
  /** Human-readable reason e.g. "3 ungroomed stories" */
  reason: string
}

export interface CeremonyView {
  ceremonyId: string
  kind: string
  title: string
  startedAt: string
  /** scheduled | in_progress | closed */
  status?: 'scheduled' | 'in_progress' | 'closed'
  participants: CeremonyParticipant[]
  /** Last N statements; chronological. */
  statements: CeremonyStatement[]
  output: Record<string, unknown> | null
  closedAt: string | null
  /**
   * Auto-scheduling trigger, if any. Absent when the ceremony was created
   * manually (override path) or when the backend has not yet wired the
   * trigger metadata into ceremony.list responses.
   */
  trigger?: CeremonyTrigger
}

export interface CeremonyStatement {
  statementId: string
  personaRole: string
  body: string
  occurredAt: string
}

interface CeremoniesState {
  /** The currently live (in_progress) ceremony, populated by WS events. */
  active: CeremonyView | null
  /**
   * Full list returned by ceremony.list (all statuses). Populated additively
   * as WS events arrive or when a list query result is received. Sorted newest
   * first.
   */
  list: CeremonyView[]
  setActive: (c: CeremonyView | null) => void
  setList: (ceremonies: CeremonyView[]) => void
  /** Insert or update a single ceremony in the list (upsert by ceremonyId). */
  upsertCeremony: (c: CeremonyView) => void
  appendStatement: (statement: CeremonyStatement) => void
  reset: () => void
}

export const useCeremoniesStore = create<CeremoniesState>((set) => ({
  active: null,
  list: [],
  setActive: (c) => set({ active: c }),
  setList: (ceremonies) => set({ list: ceremonies }),
  upsertCeremony: (c) =>
    set((state) => {
      const exists = state.list.some((x) => x.ceremonyId === c.ceremonyId)
      const list = exists
        ? state.list.map((x) => (x.ceremonyId === c.ceremonyId ? c : x))
        : [c, ...state.list]
      return { list }
    }),
  appendStatement: (statement) =>
    set((state) =>
      state.active
        ? {
            active: {
              ...state.active,
              statements: [...state.active.statements, statement].slice(-200),
            },
          }
        : state,
    ),
  reset: () => set({ active: null, list: [] }),
}))
