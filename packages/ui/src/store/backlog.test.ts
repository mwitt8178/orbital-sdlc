import { describe, it, expect, beforeEach } from 'vitest'
import { useBacklogStore, isEpicExpanded, DEFAULT_FILTERS } from './backlog.js'

beforeEach(() => {
  useBacklogStore.setState({
    filters: DEFAULT_FILTERS,
    expandedEpics: {},
    drawerStoryId: null,
    newMenuOpen: false,
  })
})

describe('useBacklogStore — filters', () => {
  it('starts with default filters (empty search)', () => {
    expect(useBacklogStore.getState().filters).toEqual(DEFAULT_FILTERS)
    expect(useBacklogStore.getState().filters.search).toBe('')
  })

  it('setFilters updates the search string', () => {
    useBacklogStore.getState().setFilters({ search: 'auth' })
    expect(useBacklogStore.getState().filters.search).toBe('auth')
  })

  it('resetFilters returns to defaults', () => {
    useBacklogStore.getState().setFilters({ search: 'foo' })
    useBacklogStore.getState().resetFilters()
    expect(useBacklogStore.getState().filters).toEqual(DEFAULT_FILTERS)
  })
})

describe('useBacklogStore — epics expansion', () => {
  it('isEpicExpanded defaults to true when no explicit setting', () => {
    expect(isEpicExpanded(useBacklogStore.getState(), 'epic-x')).toBe(true)
  })

  it('toggleEpicExpanded flips a never-touched epic to closed', () => {
    useBacklogStore.getState().toggleEpicExpanded('epic-1')
    expect(isEpicExpanded(useBacklogStore.getState(), 'epic-1')).toBe(false)
    useBacklogStore.getState().toggleEpicExpanded('epic-1')
    expect(isEpicExpanded(useBacklogStore.getState(), 'epic-1')).toBe(true)
  })

  it('setEpicExpanded sets the state explicitly', () => {
    useBacklogStore.getState().setEpicExpanded('epic-1', false)
    expect(isEpicExpanded(useBacklogStore.getState(), 'epic-1')).toBe(false)
  })
})

describe('useBacklogStore — drawer + menu', () => {
  it('openDrawer sets the story id', () => {
    useBacklogStore.getState().openDrawer('story-1')
    expect(useBacklogStore.getState().drawerStoryId).toBe('story-1')
  })

  it('closeDrawer clears the story id', () => {
    useBacklogStore.getState().openDrawer('story-1')
    useBacklogStore.getState().closeDrawer()
    expect(useBacklogStore.getState().drawerStoryId).toBeNull()
  })

  it('setNewMenuOpen toggles the manual-menu state', () => {
    useBacklogStore.getState().setNewMenuOpen(true)
    expect(useBacklogStore.getState().newMenuOpen).toBe(true)
    useBacklogStore.getState().setNewMenuOpen(false)
    expect(useBacklogStore.getState().newMenuOpen).toBe(false)
  })
})
