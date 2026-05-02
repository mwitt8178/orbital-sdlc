/**
 * AgentTalkView unit tests — pure display logic.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Tests the pure helpers: persona icon initials, channel tag colors,
 * relative time formatting, body excerpt extraction.
 * No jsdom or RTL — pure function assertions.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from AgentTalkView.tsx)
// ---------------------------------------------------------------------------

function personaIcon(personaId: string): string {
  const icons: Record<string, string> = {
    'jr-dev': 'JR',
    'sr-dev': 'SR',
    'principal-dev': 'PR',
    architect: 'AR',
    em: 'EM',
    qa: 'QA',
    security: 'SE',
    reviewer: 'RV',
    verifier: 'VR',
    pm: 'PM',
  }
  return icons[personaId] ?? personaId.slice(0, 2).toUpperCase()
}

function channelColor(channelName: string): string {
  if (channelName.startsWith('#escalation-')) return 'bg-red-100 text-red-700'
  if (channelName.startsWith('#sprint-')) return 'bg-blue-100 text-blue-700'
  if (channelName.startsWith('#review-')) return 'bg-purple-100 text-purple-700'
  if (channelName.startsWith('#orb-')) return 'bg-green-100 text-green-700'
  return 'bg-slate-100 text-slate-700'
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function bodyExcerpt(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const p = payload as Record<string, unknown>
  if (typeof p['body'] === 'string') return p['body'].slice(0, 200)
  return ''
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentTalkView display helpers', () => {
  describe('personaIcon', () => {
    it('returns known persona abbreviations', () => {
      expect(personaIcon('jr-dev')).toBe('JR')
      expect(personaIcon('sr-dev')).toBe('SR')
      expect(personaIcon('principal-dev')).toBe('PR')
      expect(personaIcon('architect')).toBe('AR')
      expect(personaIcon('em')).toBe('EM')
      expect(personaIcon('qa')).toBe('QA')
      expect(personaIcon('security')).toBe('SE')
      expect(personaIcon('reviewer')).toBe('RV')
      expect(personaIcon('verifier')).toBe('VR')
      expect(personaIcon('pm')).toBe('PM')
    })

    it('falls back to first 2 uppercase chars for unknown persona', () => {
      expect(personaIcon('custom-agent')).toBe('CU')
      expect(personaIcon('xyz')).toBe('XY')
    })
  })

  describe('channelColor', () => {
    it('returns red for escalation channels', () => {
      expect(channelColor('#escalation-sprint-123')).toBe('bg-red-100 text-red-700')
    })

    it('returns blue for sprint channels', () => {
      expect(channelColor('#sprint-abc')).toBe('bg-blue-100 text-blue-700')
    })

    it('returns purple for review channels', () => {
      expect(channelColor('#review-pr-45')).toBe('bg-purple-100 text-purple-700')
    })

    it('returns green for orb channels', () => {
      expect(channelColor('#orb-engineering')).toBe('bg-green-100 text-green-700')
    })

    it('returns slate for unknown channels', () => {
      expect(channelColor('#security-alerts')).toBe('bg-slate-100 text-slate-700')
    })
  })

  describe('formatRelativeTime', () => {
    it('shows "just now" for times < 1 min ago', () => {
      const recent = new Date(Date.now() - 10_000).toISOString()
      expect(formatRelativeTime(recent)).toBe('just now')
    })

    it('shows minutes for times 1-60 min ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
      expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago')
    })

    it('shows hours for times 1-24h ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
      expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
    })

    it('shows days for times > 24h ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
      expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago')
    })
  })

  describe('bodyExcerpt', () => {
    it('extracts body string from payload', () => {
      const payload = { body: 'This is a test message', other: 'ignored' }
      expect(bodyExcerpt(payload)).toBe('This is a test message')
    })

    it('truncates to 200 chars', () => {
      const longBody = 'x'.repeat(300)
      const payload = { body: longBody }
      expect(bodyExcerpt(payload)).toHaveLength(200)
    })

    it('returns empty string for null payload', () => {
      expect(bodyExcerpt(null)).toBe('')
    })

    it('returns empty string for payload without body', () => {
      expect(bodyExcerpt({ something_else: 'value' })).toBe('')
    })

    it('returns empty string for non-string body', () => {
      expect(bodyExcerpt({ body: 42 })).toBe('')
    })
  })
})
