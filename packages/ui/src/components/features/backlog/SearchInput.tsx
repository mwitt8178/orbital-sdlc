/**
 * SearchInput — single-input search-only filter for /backlog.
 *
 * Replaces the BacklogFilters bar (status / sprint / epic chips) that the
 * AI-pivot removed. Filtering is intentionally minimal because Monday is the
 * authoritative project-management surface; Orbital's job is just to surface
 * orchestration metadata on top of the visible stories.
 *
 * Wired to useBacklogStore.filters.search.
 */

import { useBacklogStore } from '../../../store/backlog.js'
import { Input } from '../../ui/Input.js'

export function SearchInput() {
  const search = useBacklogStore((s) => s.filters.search)
  const setFilters = useBacklogStore((s) => s.setFilters)

  return (
    <div role="region" aria-label="Backlog search" className="w-full">
      <Input
        type="search"
        placeholder="Search stories by title…"
        value={search}
        onChange={(e) => setFilters({ search: e.target.value })}
        aria-label="Search backlog"
        data-testid="backlog-search-input"
      />
    </div>
  )
}
