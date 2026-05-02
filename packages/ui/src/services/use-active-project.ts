import { useEffect } from 'react'
import { trpc } from './trpc.js'
import { useActiveProjectStore } from '../store/active-project.js'

/**
 * useActiveProject — composite hook that returns the active project +
 * setter, and lazily auto-selects the first project from `projects.list`
 * the first time the user lands on the app without a persisted choice.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Returned shape:
 *   - activeProjectId: string | null — current selection
 *   - setActiveProject(id): persist + update store
 *   - projects: Project[] — full list for the active install (active + archived
 *     based on `archived` arg)
 *   - isLoading: boolean
 *   - error: unknown
 */
export interface UseActiveProjectOptions {
  /** Pass through to projects.list filter. Default undefined = all. */
  archived?: boolean
}

export function useActiveProject(options: UseActiveProjectOptions = {}) {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)
  const setActiveProject = useActiveProjectStore((s) => s.setActiveProject)

  const list = trpc.projects.list.useQuery(
    { archived: options.archived },
    {
      staleTime: 30_000,
    },
  )

  // Auto-select the first project when nothing is selected and a list is
  // available. Runs only once per "fresh empty" state.
  useEffect(() => {
    if (activeProjectId !== null) return
    const projects = list.data
    if (!projects || projects.length === 0) return
    // Prefer active (non-archived) over archived if mixed.
    const firstActive = projects.find((p) => p.archivedAt === null) ?? projects[0]
    if (firstActive) setActiveProject(firstActive.projectId)
  }, [activeProjectId, list.data, setActiveProject])

  const activeProject =
    list.data?.find((p) => p.projectId === activeProjectId) ?? null

  return {
    activeProjectId,
    activeProject,
    setActiveProject,
    projects: list.data ?? [],
    isLoading: list.isLoading,
    error: list.error,
    refetch: list.refetch,
  }
}
