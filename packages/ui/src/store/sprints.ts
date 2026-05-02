import { create } from 'zustand'

export interface Sprint {
  id: string
  name: string
  status: 'planning' | 'ready' | 'active' | 'paused' | 'completing' | 'completed'
  startedAt: string | null
  completedAt: string | null
  /**
   * Sprint duration target in milliseconds. Optional because sprint-event
   * upserts coming from the WS layer don't carry this field; the dashboard's
   * sprint.list refetch fills it in. The Day-of-sprint counter falls back to
   * a 5-day default when null/undefined.
   */
  wallClockTargetMs?: number | null
}

interface SprintsState {
  sprints: Sprint[]
  activeSprint: Sprint | null
  setSprints: (sprints: Sprint[]) => void
  setActiveSprint: (sprint: Sprint | null) => void
  upsertSprint: (sprint: Sprint) => void
}

export const useSprintsStore = create<SprintsState>((set) => ({
  sprints: [],
  activeSprint: null,
  setSprints: (sprints) =>
    set({
      sprints,
      activeSprint:
        sprints.find((s) => s.status === 'active') ??
        sprints.find((s) => s.status === 'paused') ??
        null,
    }),
  setActiveSprint: (sprint) => set({ activeSprint: sprint }),
  upsertSprint: (sprint) =>
    set((state) => {
      const existing = state.sprints.findIndex((s) => s.id === sprint.id)
      const next =
        existing >= 0
          ? state.sprints.map((s) => (s.id === sprint.id ? sprint : s))
          : [...state.sprints, sprint]
      return {
        sprints: next,
        activeSprint:
          next.find((s) => s.status === 'active') ??
          next.find((s) => s.status === 'paused') ??
          state.activeSprint,
      }
    }),
}))
