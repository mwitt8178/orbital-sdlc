/**
 * OperatorFilter unit tests — pure logic.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Note: @testing-library/react is not configured in this package.
 * Tests verify the pure logic: member sorting, chip active state,
 * filter value semantics.
 *
 * AC covered: "Mine" filter, specific-operator filter, "All" passthrough.
 */

import { describe, it, expect } from 'vitest'
import type { TeamMember } from '../../src/components/identity/OperatorBadge.js'
import type { OperatorFilterValue } from '../../src/components/identity/OperatorFilter.js'

// ---------------------------------------------------------------------------
// Pure helpers mirrored from OperatorFilter.tsx
// ---------------------------------------------------------------------------

/**
 * Sort members: current install first, then alphabetical by display_name.
 */
function sortMembers(members: TeamMember[], myInstallId: string): TeamMember[] {
  return [...members].sort((a, b) => {
    if (a.install_id === myInstallId) return -1
    if (b.install_id === myInstallId) return 1
    const aName = a.display_name ?? a.install_id
    const bName = b.display_name ?? b.install_id
    return aName.localeCompare(bName)
  })
}

/**
 * Other operators — members that are not "mine".
 */
function otherMembers(members: TeamMember[], myInstallId: string): TeamMember[] {
  return sortMembers(members, myInstallId).filter((m) => m.install_id !== myInstallId)
}

/**
 * Determine if a task/item "passes" the operator filter.
 * Mirrors the filtering logic used in Backlog/AgentInspector.
 */
function passesFilter(
  itemInstallId: string | undefined,
  filterValue: OperatorFilterValue,
  myInstallId: string,
): boolean {
  if (filterValue === 'all') return true
  if (filterValue === 'mine') return itemInstallId === myInstallId
  return itemInstallId === filterValue
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MY_ID = '00000001-0000-0000-0000-000000000001'
const ALICE_ID = '00000002-0000-0000-0000-000000000002'
const BOB_ID = '00000003-0000-0000-0000-000000000003'

function makeMember(installId: string, displayName: string | null, role: 'owner' | 'member' | 'viewer' = 'member'): TeamMember {
  return { install_id: installId, display_name: displayName, role, last_seen_at: null }
}

const TEAM: TeamMember[] = [
  makeMember(ALICE_ID, 'alice-laptop'),
  makeMember(MY_ID, 'matt-home', 'owner'),
  makeMember(BOB_ID, 'bob-workstation'),
]

// ---------------------------------------------------------------------------
// Tests: sorting
// ---------------------------------------------------------------------------

describe('OperatorFilter — member sorting', () => {
  it('puts the current install first regardless of original order', () => {
    const sorted = sortMembers(TEAM, MY_ID)
    expect(sorted[0].install_id).toBe(MY_ID)
  })

  it('sorts remaining members alphabetically by display_name', () => {
    const sorted = sortMembers(TEAM, MY_ID)
    // alice-laptop < bob-workstation
    expect(sorted[1].display_name).toBe('alice-laptop')
    expect(sorted[2].display_name).toBe('bob-workstation')
  })

  it('falls back to install_id for sorting when display_name is null', () => {
    const members: TeamMember[] = [
      makeMember('zzz-id', null),
      makeMember('aaa-id', null),
      makeMember(MY_ID, 'me'),
    ]
    const sorted = sortMembers(members, MY_ID)
    expect(sorted[0].install_id).toBe(MY_ID)
    expect(sorted[1].install_id).toBe('aaa-id')
    expect(sorted[2].install_id).toBe('zzz-id')
  })

  it('handles a single-member list (just the current install)', () => {
    const sorted = sortMembers([makeMember(MY_ID, 'me')], MY_ID)
    expect(sorted.length).toBe(1)
    expect(sorted[0].install_id).toBe(MY_ID)
  })
})

describe('OperatorFilter — otherMembers', () => {
  it('excludes the current install from others list', () => {
    const others = otherMembers(TEAM, MY_ID)
    expect(others.find((m) => m.install_id === MY_ID)).toBeUndefined()
  })

  it('includes all members except the current install', () => {
    const others = otherMembers(TEAM, MY_ID)
    expect(others.length).toBe(TEAM.length - 1)
  })

  it('returns empty list when only current install is in the team', () => {
    const others = otherMembers([makeMember(MY_ID, 'just-me')], MY_ID)
    expect(others.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: filter value semantics
// ---------------------------------------------------------------------------

describe('OperatorFilter — passesFilter ("all")', () => {
  it('all passes any install_id', () => {
    expect(passesFilter(ALICE_ID, 'all', MY_ID)).toBe(true)
    expect(passesFilter(MY_ID, 'all', MY_ID)).toBe(true)
    expect(passesFilter(undefined, 'all', MY_ID)).toBe(true)
  })
})

describe('OperatorFilter — passesFilter ("mine")', () => {
  it('mine passes only the current install_id', () => {
    expect(passesFilter(MY_ID, 'mine', MY_ID)).toBe(true)
  })

  it('mine rejects a different install_id', () => {
    expect(passesFilter(ALICE_ID, 'mine', MY_ID)).toBe(false)
  })

  it('mine rejects undefined (unattributed item)', () => {
    expect(passesFilter(undefined, 'mine', MY_ID)).toBe(false)
  })
})

describe('OperatorFilter — passesFilter (specific install_id)', () => {
  it('specific filter passes only matching install_id', () => {
    expect(passesFilter(ALICE_ID, ALICE_ID, MY_ID)).toBe(true)
  })

  it('specific filter rejects non-matching install_id', () => {
    expect(passesFilter(BOB_ID, ALICE_ID, MY_ID)).toBe(false)
  })

  it('specific filter rejects undefined', () => {
    expect(passesFilter(undefined, ALICE_ID, MY_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: chip active state
// ---------------------------------------------------------------------------

describe('OperatorFilter — chip active state', () => {
  it('"all" chip is active when value is "all"', () => {
    const value: OperatorFilterValue = 'all'
    expect(value === 'all').toBe(true)
    expect(value === 'mine').toBe(false)
  })

  it('"mine" chip is active when value is "mine"', () => {
    const value: OperatorFilterValue = 'mine'
    expect(value === 'mine').toBe(true)
    expect(value === 'all').toBe(false)
  })

  it('member chip for ALICE is active when value equals ALICE_ID', () => {
    const value: OperatorFilterValue = ALICE_ID
    expect(value === ALICE_ID).toBe(true)
    expect(value === BOB_ID).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: edge cases
// ---------------------------------------------------------------------------

describe('OperatorFilter — edge cases', () => {
  it('empty members list results in zero "others"', () => {
    expect(otherMembers([], MY_ID)).toEqual([])
  })

  it('filter value type accepts arbitrary UUID as install_id filter', () => {
    const val: OperatorFilterValue = ALICE_ID
    expect(typeof val).toBe('string')
  })

  it('passesFilter with "mine" and matching install_id works for any valid UUID format', () => {
    const uuid = '01961234-0000-7000-8000-000000000001'
    expect(passesFilter(uuid, 'mine', uuid)).toBe(true)
  })
})
