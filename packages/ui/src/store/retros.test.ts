/**
 * Tests for the retros store WS apply methods.
 *
 * Pure store logic — no DOM/React required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useRetrosStore } from './retros.js'

function resetStore() {
  useRetrosStore.setState({
    selectedReportId: null,
    pendingProposalId: null,
    pendingAction: null,
    proposalStates: {},
  })
}

describe('useRetrosStore WS apply methods', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('applyProposalApproved', () => {
    it('adds approved entry to proposalStates', () => {
      useRetrosStore.getState().applyProposalApproved({
        proposal_id: 'prop-001',
        report_id: 'report-abc',
        occurred_at: '2026-01-01T10:00:00Z',
      })
      const entry = useRetrosStore.getState().proposalStates['prop-001']!
      expect(entry.status).toBe('approved')
      expect(entry.reportId).toBe('report-abc')
      expect(entry.decidedAt).toBe('2026-01-01T10:00:00Z')
    })
  })

  describe('applyProposalRejected', () => {
    it('adds rejected entry to proposalStates', () => {
      useRetrosStore.getState().applyProposalRejected({
        proposal_id: 'prop-002',
        report_id: 'report-abc',
        reason: 'Out of scope',
        occurred_at: '2026-01-01T11:00:00Z',
      })
      const entry = useRetrosStore.getState().proposalStates['prop-002']!
      expect(entry.status).toBe('rejected')
      expect(entry.decidedAt).toBe('2026-01-01T11:00:00Z')
    })
  })

  describe('applyProposalDeferred', () => {
    it('adds deferred entry to proposalStates', () => {
      useRetrosStore.getState().applyProposalDeferred({
        proposal_id: 'prop-003',
        report_id: 'report-abc',
        occurred_at: '2026-01-01T12:00:00Z',
      })
      const entry = useRetrosStore.getState().proposalStates['prop-003']!
      expect(entry.status).toBe('deferred')
    })
  })

  it('multiple proposals coexist without clobbering', () => {
    useRetrosStore.getState().applyProposalApproved({
      proposal_id: 'prop-001',
      report_id: 'report-abc',
    })
    useRetrosStore.getState().applyProposalRejected({
      proposal_id: 'prop-002',
      report_id: 'report-abc',
    })
    const states = useRetrosStore.getState().proposalStates
    expect(states['prop-001']!.status).toBe('approved')
    expect(states['prop-002']!.status).toBe('rejected')
  })

  it('decidedAt falls back to current time when occurred_at is absent', () => {
    const before = Date.now()
    useRetrosStore.getState().applyProposalApproved({
      proposal_id: 'prop-004',
      report_id: 'report-abc',
    })
    const after = Date.now()
    const entry = useRetrosStore.getState().proposalStates['prop-004']!
    const decidedMs = new Date(entry.decidedAt!).getTime()
    expect(decidedMs).toBeGreaterThanOrEqual(before)
    expect(decidedMs).toBeLessThanOrEqual(after)
  })

  describe('existing state management', () => {
    it('setSelectedReport', () => {
      useRetrosStore.getState().setSelectedReport('report-1')
      expect(useRetrosStore.getState().selectedReportId).toBe('report-1')
    })

    it('beginProposalAction + clearProposalAction round-trip', () => {
      useRetrosStore.getState().beginProposalAction('prop-x', 'approve')
      expect(useRetrosStore.getState().pendingProposalId).toBe('prop-x')
      expect(useRetrosStore.getState().pendingAction).toBe('approve')
      useRetrosStore.getState().clearProposalAction()
      expect(useRetrosStore.getState().pendingProposalId).toBeNull()
      expect(useRetrosStore.getState().pendingAction).toBeNull()
    })
  })
})
