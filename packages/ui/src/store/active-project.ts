import { create } from 'zustand'

/**
 * Persisted active-project store.
 *
 * Per Round 4 Projects Feature spec.
 *
 * The store is intentionally small: just the active project id + a setter +
 * a hydration entry-point. The header injection in services/trpc.ts reads
 * `activeProjectId` directly so every tRPC call is automatically scoped.
 *
 * Persistence is hand-rolled rather than via zustand/middleware/persist
 * because we want a minimal, no-rehydration-flash UX:
 *   - SSR-safe: localStorage access is wrapped in `typeof window` guards.
 *   - Synchronous read on store creation: the initial state already reflects
 *     the persisted value before React mounts.
 *   - Explicit hydrate() to re-pull (used after an async list response when
 *     localStorage was empty and we need to default to the first project).
 */

const LOCAL_STORAGE_KEY = 'orbital.active_project_id'

function readPersisted(): string | null {
  try {
    if (typeof window === 'undefined') return null
    const v = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

function writePersisted(value: string | null): void {
  try {
    if (typeof window === 'undefined') return
    if (value === null) window.localStorage.removeItem(LOCAL_STORAGE_KEY)
    else window.localStorage.setItem(LOCAL_STORAGE_KEY, value)
  } catch {
    // localStorage unavailable (private mode); silently degrade.
  }
}

interface ActiveProjectState {
  activeProjectId: string | null
  setActiveProject: (projectId: string | null) => void
  /** Re-read from localStorage. Useful after auth/install change. */
  hydrate: () => void
}

export const useActiveProjectStore = create<ActiveProjectState>((set) => ({
  activeProjectId: readPersisted(),
  setActiveProject: (projectId) => {
    writePersisted(projectId)
    set({ activeProjectId: projectId })
  },
  hydrate: () => set({ activeProjectId: readPersisted() }),
}))

/**
 * Synchronous, store-free reader. Used by the tRPC header link so the value
 * is always fresh on every request without subscribing to the store.
 */
export function getActiveProjectId(): string | null {
  return useActiveProjectStore.getState().activeProjectId
}
