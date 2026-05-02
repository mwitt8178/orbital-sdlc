/**
 * store/backlog.ts — UI-only state for the /backlog page.
 *
 * Server data (epics, stories, sprints) is owned by react-query via the tRPC
 * client. This store holds only ephemeral view state:
 *   - filter: a single search string (Monday is the authoritative kanban —
 *     status / sprint / epic chips were removed when the page pivoted to a
 *     thin visualization layer)
 *   - which epic accordions are expanded
 *   - the currently-open story drawer (story_id)
 *   - the "+ Manual" menu open state
 *
 * Persistence: none. View state resets on page reload, which is the right
 * behaviour for a working surface.
 *
 * Removed in the AI-pivot:
 *   - dragSourceStoryId / dragHoverSprintId (no more HTML5 DnD)
 *   - selectedStoryIds (no more bulk-select)
 *   - status/priority/sprint/epic filter chips (Monday's job)
 */

import { create } from 'zustand'

// Local copy of the StoryStatus union (mirrors db/schema/backlog.ts STORY_STATUS).
// We don't import @orbital/types here because StoryStatus isn't surfaced there;
// the orchestrator's tRPC router types still flow through for end-to-end safety
// when stories are passed across the boundary.
export const ALL_STORY_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'accepted',
  'blocked',
  'defective',
  'cancelled',
] as const
export type BacklogStoryStatus = (typeof ALL_STORY_STATUSES)[number]

export interface BacklogFiltersState {
  search: string
}

const DEFAULT_FILTERS: BacklogFiltersState = {
  search: '',
}

interface BacklogState {
  filters: BacklogFiltersState

  /** epic_id -> open boolean. Default open if missing. */
  expandedEpics: Record<string, boolean>

  /** Currently-open story drawer; null when closed. */
  drawerStoryId: string | null

  /** "+ Manual" dropdown open state. */
  newMenuOpen: boolean

  // ---- actions ----
  setFilters: (patch: Partial<BacklogFiltersState>) => void
  resetFilters: () => void

  setEpicExpanded: (epicId: string, expanded: boolean) => void
  toggleEpicExpanded: (epicId: string) => void

  openDrawer: (storyId: string) => void
  closeDrawer: () => void

  setNewMenuOpen: (open: boolean) => void
}

export const useBacklogStore = create<BacklogState>((set) => ({
  filters: DEFAULT_FILTERS,
  expandedEpics: {},
  drawerStoryId: null,
  newMenuOpen: false,

  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),

  resetFilters: () => set({ filters: DEFAULT_FILTERS }),

  setEpicExpanded: (epicId, expanded) =>
    set((s) => ({ expandedEpics: { ...s.expandedEpics, [epicId]: expanded } })),

  toggleEpicExpanded: (epicId) =>
    set((s) => {
      const current = s.expandedEpics[epicId]
      // Default open: if undefined, treat as open and toggle to closed.
      const next = current === undefined ? false : !current
      return { expandedEpics: { ...s.expandedEpics, [epicId]: next } }
    }),

  openDrawer: (storyId) => set({ drawerStoryId: storyId }),
  closeDrawer: () => set({ drawerStoryId: null }),

  setNewMenuOpen: (open) => set({ newMenuOpen: open }),
}))

/**
 * Convenience selector — is the epic currently expanded? Defaults to true
 * (we open all epics on first render so the working surface is dense).
 */
export function isEpicExpanded(state: BacklogState, epicId: string): boolean {
  const explicit = state.expandedEpics[epicId]
  return explicit === undefined ? true : explicit
}

// Re-export for components that need a typed default
export { DEFAULT_FILTERS }
