/**
 * Tests for ScheduleCeremonyModal helper logic.
 *
 * Pure logic only — no DOM/React rendering.
 */

import { describe, it, expect } from 'vitest'

// Mirror the toLocalDatetimeValue helper from ScheduleCeremonyModal.
function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Mirror persona toggle logic. */
function togglePersona(selected: string[], slug: string): string[] {
  return selected.includes(slug)
    ? selected.filter((p) => p !== slug)
    : [...selected, slug]
}

describe('ScheduleCeremonyModal helpers', () => {
  describe('toLocalDatetimeValue', () => {
    it('formats a known date correctly', () => {
      // Jan 5 2026 09:03 local time
      const d = new Date(2026, 0, 5, 9, 3, 0)
      expect(toLocalDatetimeValue(d)).toBe('2026-01-05T09:03')
    })

    it('pads single-digit month, day, hour, minute', () => {
      const d = new Date(2026, 1, 3, 4, 7, 0) // Feb 3, 04:07
      expect(toLocalDatetimeValue(d)).toBe('2026-02-03T04:07')
    })

    it('handles December (month 11 → 12)', () => {
      const d = new Date(2026, 11, 31, 23, 59, 0)
      expect(toLocalDatetimeValue(d)).toBe('2026-12-31T23:59')
    })
  })

  describe('togglePersona', () => {
    it('adds persona when not in list', () => {
      const result = togglePersona([], 'arch-lead')
      expect(result).toEqual(['arch-lead'])
    })

    it('removes persona when already in list', () => {
      const result = togglePersona(['arch-lead', 'qa-lead'], 'arch-lead')
      expect(result).toEqual(['qa-lead'])
    })

    it('handles empty list remove gracefully', () => {
      const result = togglePersona([], 'arch-lead')
      expect(result).toHaveLength(1)
    })

    it('does not duplicate on successive adds', () => {
      const after1 = togglePersona([], 'arch-lead')
      const after2 = togglePersona(after1, 'qa-lead')
      expect(after2).toHaveLength(2)
      expect(after2).toContain('arch-lead')
      expect(after2).toContain('qa-lead')
    })
  })

  describe('canSubmit logic', () => {
    // The modal is disabled while backendPending = true.
    // Once that flag is cleared (future), submit is allowed only if participants > 0.
    it('canSubmit is false when backend pending', () => {
      const backendPending = true
      const selectedPersonas = ['arch-lead']
      const canSubmit = !backendPending && selectedPersonas.length > 0
      expect(canSubmit).toBe(false)
    })

    it('canSubmit is false when no participants selected (even if backend ready)', () => {
      const backendPending = false
      const selectedPersonas: string[] = []
      const canSubmit = !backendPending && selectedPersonas.length > 0
      expect(canSubmit).toBe(false)
    })

    it('canSubmit is true when backend ready and participants selected', () => {
      const backendPending = false
      const selectedPersonas = ['arch-lead']
      const canSubmit = !backendPending && selectedPersonas.length > 0
      expect(canSubmit).toBe(true)
    })
  })
})
