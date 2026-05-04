/**
 * ActiveProjectUrlSync — keeps the URL `?project=<id>` query param in lockstep
 * with the active project store, so deep-links land on the correct project.
 *
 * Behaviour:
 *  - On every change of `activeProjectId`, write `?project=<id>` to the URL
 *    using `replace` (no history spam).
 *  - On mount, if the URL carries a `?project=<id>` AND that id is present in
 *    the user's project list, adopt it (URL wins on deep-link). If the id is
 *    not in the list (foreign tenant id, archived, deleted), silently strip
 *    it — don't 403 the user.
 *
 * Renders nothing.
 *
 * [Engineer-Principal · Opus · run-ux-4-nav]
 */

import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useActiveProject } from '../../services/use-active-project.js'

const QUERY_KEY = 'project'

export function ActiveProjectUrlSync() {
  const { activeProjectId, projects, setActiveProject, isLoading } = useActiveProject()
  const [searchParams, setSearchParams] = useSearchParams()

  // URL → store: adopt deep-link selection once projects are loaded.
  useEffect(() => {
    if (isLoading) return
    const urlId = searchParams.get(QUERY_KEY)
    if (!urlId) return
    if (urlId === activeProjectId) return
    const isKnown = projects.some((p: { projectId: string }) => p.projectId === urlId)
    if (!isKnown) {
      // Strip stale/foreign id; don't fight the user with errors.
      const next = new URLSearchParams(searchParams)
      next.delete(QUERY_KEY)
      setSearchParams(next, { replace: true })
      return
    }
    setActiveProject(urlId)
  }, [isLoading, projects, activeProjectId, searchParams, setActiveProject, setSearchParams])

  // Store → URL: keep query param current.
  useEffect(() => {
    if (!activeProjectId) return
    if (searchParams.get(QUERY_KEY) === activeProjectId) return
    const next = new URLSearchParams(searchParams)
    next.set(QUERY_KEY, activeProjectId)
    setSearchParams(next, { replace: true })
  }, [activeProjectId, searchParams, setSearchParams])

  return null
}
