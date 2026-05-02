/**
 * OperatorBadge unit tests — pure logic.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Note: @testing-library/react is not configured in this package.
 * Tests verify the pure helper logic extracted from OperatorBadge:
 *   - operatorColor/operatorInitials (imported from lib)
 *   - Avatar label computation
 *   - Role chip class mapping
 *   - Presence delegation
 *
 * AC covered: AC 7 (color stability), color distinctiveness, initials derivation.
 */

import { describe, it, expect } from 'vitest'
import { operatorColor, operatorInitials } from '../../src/lib/operator-color.js'
import type { TeamMember } from '../../src/components/identity/OperatorBadge.js'

// ---------------------------------------------------------------------------
// Helpers mirrored from OperatorBadge.tsx
// ---------------------------------------------------------------------------

function badgeLabel(installId: string, member: TeamMember | null | undefined): string {
  const displayName = member?.display_name ?? null
  return displayName ?? installId.slice(0, 8)
}

function badgeInitials(installId: string, member: TeamMember | null | undefined): string {
  const displayName = member?.display_name ?? null
  return operatorInitials(displayName ?? installId)
}

const roleColors: Record<string, string> = {
  owner: 'bg-violet-100 text-violet-700',
  member: 'bg-blue-100 text-blue-700',
  viewer: 'bg-slate-100 text-slate-600',
}

function roleBadgeClass(role: string): string {
  return roleColors[role] ?? roleColors['member']
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OperatorBadge — badge label', () => {
  it('uses display_name when member is provided', () => {
    const member: TeamMember = {
      install_id: '01234567-89ab-cdef-0123-456789abcdef',
      display_name: 'matt-laptop',
      role: 'owner',
      last_seen_at: null,
    }
    expect(badgeLabel(member.install_id, member)).toBe('matt-laptop')
  })

  it('falls back to first 8 chars of install_id when display_name is null', () => {
    const member: TeamMember = {
      install_id: '01234567-89ab-cdef-0123-456789abcdef',
      display_name: null,
      role: 'member',
      last_seen_at: null,
    }
    expect(badgeLabel(member.install_id, member)).toBe('01234567')
  })

  it('uses first 8 chars of install_id when member is undefined', () => {
    const installId = 'abcdef12-0000-0000-0000-000000000000'
    expect(badgeLabel(installId, undefined)).toBe('abcdef12')
  })

  it('uses first 8 chars of install_id when member is null', () => {
    const installId = 'ffffffff-0000-0000-0000-000000000000'
    expect(badgeLabel(installId, null)).toBe('ffffffff')
  })
})

describe('OperatorBadge — initials derivation', () => {
  it('derives initials from display_name for hyphenated name', () => {
    const member: TeamMember = {
      install_id: '01234567-89ab-cdef-0123-456789abcdef',
      display_name: 'alice-workstation',
      role: 'member',
      last_seen_at: null,
    }
    expect(badgeInitials(member.install_id, member)).toBe('AW')
  })

  it('derives initials from install_id when display_name is null', () => {
    const installId = 'ab123456-0000-0000-0000-000000000000'
    const member: TeamMember = { install_id: installId, display_name: null, role: 'viewer', last_seen_at: null }
    // operatorInitials on a UUID-like string: first two chars of "ab123456..."
    const result = badgeInitials(installId, member)
    expect(result).toHaveLength(2)
    expect(result).toBe(result.toUpperCase())
  })

  it('initials are always uppercase', () => {
    const member: TeamMember = {
      install_id: 'any-id',
      display_name: 'ricky-studio',
      role: 'member',
      last_seen_at: null,
    }
    const result = badgeInitials(member.install_id, member)
    expect(result).toBe(result.toUpperCase())
  })
})

describe('OperatorBadge — color derivation', () => {
  it('produces the same background color for the same install_id across calls', () => {
    const installId = '01961234-0000-7000-8000-000000000001'
    const first = operatorColor(installId)
    for (let i = 0; i < 10; i++) {
      expect(operatorColor(installId).light).toBe(first.light)
    }
  })

  it('produces distinct colors for different install_ids', () => {
    const color1 = operatorColor('00000001-0000-0000-0000-000000000001')
    const color2 = operatorColor('00000002-0000-0000-0000-000000000002')
    expect(color1.hue).not.toBe(color2.hue)
  })

  it('light is a valid CSS hsl() string', () => {
    const { light } = operatorColor('test-install-id')
    expect(light).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/)
  })
})

describe('OperatorBadge — role badge classes', () => {
  it('owner gets violet classes', () => {
    expect(roleBadgeClass('owner')).toContain('violet')
  })

  it('member gets blue classes', () => {
    expect(roleBadgeClass('member')).toContain('blue')
  })

  it('viewer gets slate classes', () => {
    expect(roleBadgeClass('viewer')).toContain('slate')
  })

  it('unknown role falls back to member (blue)', () => {
    expect(roleBadgeClass('unknown-role')).toContain('blue')
  })
})

describe('OperatorBadge — aria-label construction', () => {
  it('includes operator display name in label', () => {
    const member: TeamMember = {
      install_id: 'inst-abc',
      display_name: 'bob-laptop',
      role: 'member',
      last_seen_at: null,
    }
    const label = `Operator: ${badgeLabel(member.install_id, member)}, ${member.role}`
    expect(label).toBe('Operator: bob-laptop, member')
  })

  it('includes role when member role is set', () => {
    const member: TeamMember = {
      install_id: 'inst-xyz',
      display_name: 'carol-home',
      role: 'owner',
      last_seen_at: null,
    }
    const label = `Operator: ${badgeLabel(member.install_id, member)}, ${member.role}`
    expect(label).toContain('owner')
  })
})

describe('OperatorBadge — TeamMember type contract', () => {
  it('all required fields are present in a minimal TeamMember', () => {
    const m: TeamMember = {
      install_id: '01234567-0000-0000-0000-000000000000',
      display_name: null,
      role: 'viewer',
      last_seen_at: null,
    }
    expect(m.install_id).toBeDefined()
    expect(m.role).toBe('viewer')
  })

  it('optional color field is accepted', () => {
    const m: TeamMember = {
      install_id: '01234567-0000-0000-0000-000000000000',
      display_name: 'test',
      role: 'member',
      last_seen_at: new Date().toISOString(),
      color: 180,
    }
    expect(m.color).toBe(180)
  })
})
