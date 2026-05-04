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
  // available. Also reconcile a stale persisted id that no longer exists in
  // the list — without this, the switcher renders "No projects" while the
  // store holds a phantom id from a previous install.
  // [Engineer-Principal · Opus · run-post-onboarding]
  useEffect(() => {
    const projects = list.data
    if (!projects) return
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProject(null)
      return
    }
    const exists =
      activeProjectId !== null && projects.some((p) => p.projectId === activeProjectId)
    if (!exists) {
      const firstActive = projects.find((p) => p.archivedAt === null) ?? projects[0]
      if (firstActive) setActiveProject(firstActive.projectId)
    }
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
