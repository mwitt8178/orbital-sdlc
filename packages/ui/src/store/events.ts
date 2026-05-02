import { create } from 'zustand'
import type { EventEnvelope } from '@orbital/types'

const MAX_EVENTS = 200

interface EventsState {
  events: EventEnvelope[]
  cursor: string | null
  appendEvent: (event: EventEnvelope) => void
  setCursor: (cursor: string | null) => void
  reset: () => void
}

export const useEventsStore = create<EventsState>((set) => ({
  events: [],
  cursor: null,
  appendEvent: (event) =>
    set((state) => ({
      events: [...state.events, event].slice(-MAX_EVENTS),
      cursor: event.event_id,
    })),
  setCursor: (cursor) => set({ cursor }),
  reset: () => set({ events: [], cursor: null }),
}))
