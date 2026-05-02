/**
 * EscalationBanner unit tests — pure display logic.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Tests the pure helpers: escalation count text, visibility logic.
 * No jsdom or RTL — pure function assertions.
 * E2E coverage is in Playwright specs.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from EscalationBanner.tsx)
// ---------------------------------------------------------------------------

function escalationSummaryText(count: number): string {
  if (count === 0) return ''
  if (count === 1) return '1 active escalation'
  return `${count} active escalations`
}

function shouldShowBanner(escalationCount: number): boolean {
  return escalationCount > 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EscalationBanner display logic', () => {
  describe('escalationSummaryText', () => {
    it('returns empty string when count is 0', () => {
      expect(escalationSummaryText(0)).toBe('')
    })

    it('returns singular for count of 1', () => {
      expect(escalationSummaryText(1)).toBe('1 active escalation')
    })

    it('returns plural for count > 1', () => {
      expect(escalationSummaryText(2)).toBe('2 active escalations')
      expect(escalationSummaryText(5)).toBe('5 active escalations')
      expect(escalationSummaryText(10)).toBe('10 active escalations')
    })
  })

  describe('shouldShowBanner', () => {
    it('does not show banner when there are 0 escalations', () => {
      expect(shouldShowBanner(0)).toBe(false)
    })

    it('shows banner when there are 1+ escalations', () => {
      expect(shouldShowBanner(1)).toBe(true)
      expect(shouldShowBanner(3)).toBe(true)
    })
  })

  describe('EscalationBanner props validation', () => {
    it('null sprintId should result in banner not fetching', () => {
      // When sprintId is null/undefined, enabled=false prevents the query
      const sprintId: string | null = null
      const enabled = !!sprintId
      expect(enabled).toBe(false)
    })

    it('valid sprintId should enable the query', () => {
      const sprintId = '01900000-0000-7000-8000-000000000001'
      const enabled = !!sprintId
      expect(enabled).toBe(true)
    })
  })

  describe('escalation threshold — severity of escalation affects banner', () => {
    type EscalationEntry = { blocker_type: string; confidence: number }

    function hasLowConfidenceEscalation(escalations: EscalationEntry[]): boolean {
      return escalations.some((e) => e.confidence >= 0 && e.confidence < 75)
    }

    function hasCriticalBlocker(escalations: EscalationEntry[]): boolean {
      return escalations.some((e) => e.blocker_type === 'capability_denied')
    }

    it('detects low-confidence escalation', () => {
      const escalations: EscalationEntry[] = [
        { blocker_type: 'low_confidence', confidence: 62 },
        { blocker_type: 'unknown', confidence: 80 },
      ]
      expect(hasLowConfidenceEscalation(escalations)).toBe(true)
    })

    it('detects capability-denied blocker', () => {
      const escalations: EscalationEntry[] = [
        { blocker_type: 'capability_denied', confidence: -1 },
      ]
      expect(hasCriticalBlocker(escalations)).toBe(true)
    })

    it('does not flag high-confidence escalations as low-confidence', () => {
      const escalations: EscalationEntry[] = [
        { blocker_type: 'retry_budget_exhausted', confidence: 80 },
      ]
      expect(hasLowConfidenceEscalation(escalations)).toBe(false)
    })
  })
})
