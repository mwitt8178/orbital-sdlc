/**
 * Tests for MentionAutocomplete filtering logic.
 *
 * Pure logic only — no DOM rendering (node environment).
 */

import { describe, it, expect } from 'vitest'

// Mirror the FALLBACK_PERSONAS list from MentionAutocomplete.
const FALLBACK_PERSONAS = [
  'arch-lead',
  'backend-senior',
  'frontend-senior',
  'qa-lead',
  'product-manager',
  'tech-lead',
  'devops-engineer',
  'security-reviewer',
  'data-engineer',
  'ux-designer',
  'scrum-master',
]

/** Filter personas by query string — mirrors the component logic. */
function filterPersonas(query: string): string[] {
  return query
    ? FALLBACK_PERSONAS.filter((p) => p.toLowerCase().includes(query.toLowerCase()))
    : FALLBACK_PERSONAS.slice(0, 8)
}

describe('MentionAutocomplete filtering', () => {
  it('returns first 8 personas for empty query', () => {
    const result = filterPersonas('')
    expect(result).toHaveLength(8)
    expect(result[0]).toBe('arch-lead')
  })

  it('filters case-insensitively by substring', () => {
    expect(filterPersonas('lead')).toEqual(['arch-lead', 'qa-lead', 'tech-lead'])
    expect(filterPersonas('LEAD')).toEqual(['arch-lead', 'qa-lead', 'tech-lead'])
  })

  it('returns empty array when no match', () => {
    expect(filterPersonas('zzzzz')).toEqual([])
  })

  it('matches on middle-of-string', () => {
    expect(filterPersonas('senior')).toEqual(['backend-senior', 'frontend-senior'])
  })

  it('single character query returns matching personas', () => {
    const result = filterPersonas('q')
    expect(result).toContain('qa-lead')
  })

  it('full slug match returns single result', () => {
    expect(filterPersonas('arch-lead')).toEqual(['arch-lead'])
  })
})
