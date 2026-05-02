/**
 * Tests for the UAT store WS apply methods.
 *
 * Pure store logic — no DOM/React required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useUATStore } from './uat.js'

function resetStore() {
  useUATStore.setState({
    selectedTicketId: null,
    selectedSessionId: null,
    draftObservedBehavior: {},
    defectCache: {},
  })
}

describe('useUATStore WS apply methods', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('applyDefectCreated', () => {
    it('adds defect to cache', () => {
      useUATStore.getState().applyDefectCreated({
        defect_id: 'def-001',
        defect_key: 'DEF-001',
        title: 'Login button broken',
        severity: 'high',
        state: 'open',
        origin_story_id: 'story-123',
        persona_of_record_id: 'arch-lead',
        ac_id: 'ac-456',
        session_id: 'session-789',
      })
      const cache = useUATStore.getState().defectCache
      expect(cache['def-001']).toBeDefined()
      expect(cache['def-001']!.defectKey).toBe('DEF-001')
      expect(cache['def-001']!.title).toBe('Login button broken')
      expect(cache['def-001']!.state).toBe('open')
    })

    it('is idempotent — overwrites on second call', () => {
      const base = {
        defect_id: 'def-001',
        defect_key: 'DEF-001',
        title: 'Old title',
        severity: 'low',
        state: 'open',
        origin_story_id: 'story-123',
        persona_of_record_id: null,
        ac_id: null,
        session_id: null,
      }
      useUATStore.getState().applyDefectCreated(base)
      useUATStore.getState().applyDefectCreated({ ...base, title: 'New title', severity: 'high' })
      const entry = useUATStore.getState().defectCache['def-001']!
      expect(entry.title).toBe('New title')
      expect(entry.severity).toBe('high')
    })
  })

  describe('applyDefectReopened', () => {
    it('updates state to open for known defect', () => {
      useUATStore.getState().applyDefectCreated({
        defect_id: 'def-002',
        defect_key: 'DEF-002',
        title: 'Something wrong',
        severity: 'medium',
        state: 'closed',
        origin_story_id: 'story-abc',
        persona_of_record_id: null,
        ac_id: null,
        session_id: null,
      })
      useUATStore.getState().applyDefectReopened({ defect_id: 'def-002' })
      expect(useUATStore.getState().defectCache['def-002']!.state).toBe('open')
    })

    it('is a no-op for unknown defect', () => {
      useUATStore.getState().applyDefectReopened({ defect_id: 'does-not-exist' })
      expect(useUATStore.getState().defectCache).toEqual({})
    })
  })

  describe('existing state management', () => {
    it('setSelectedTicket and setSelectedSession round-trip', () => {
      useUATStore.getState().setSelectedTicket('ticket-1')
      useUATStore.getState().setSelectedSession('session-1')
      const state = useUATStore.getState()
      expect(state.selectedTicketId).toBe('ticket-1')
      expect(state.selectedSessionId).toBe('session-1')
    })

    it('setDraftObservedBehavior merges without clobbering other entries', () => {
      useUATStore.getState().setDraftObservedBehavior('ac-1', 'obs a')
      useUATStore.getState().setDraftObservedBehavior('ac-2', 'obs b')
      const drafts = useUATStore.getState().draftObservedBehavior
      expect(drafts['ac-1']).toBe('obs a')
      expect(drafts['ac-2']).toBe('obs b')
    })

    it('clearDrafts empties draftObservedBehavior', () => {
      useUATStore.getState().setDraftObservedBehavior('ac-1', 'obs a')
      useUATStore.getState().clearDrafts()
      expect(useUATStore.getState().draftObservedBehavior).toEqual({})
    })
  })
})
