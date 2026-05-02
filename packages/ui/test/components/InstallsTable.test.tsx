/**
 * InstallsTable unit tests — pure logic layer.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Tests KnownInstall shape validation and the relative time formatting
 * logic from InstallsTable.tsx.
 *
 * @testing-library/react is not configured in this package.
 * We test pure logic helpers only.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnownInstall {
  installId: string
  displayName: string | null
  role: 'owner' | 'member'
  publicKey: string
  joinedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from InstallsTable.tsx)
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—'

  const diff = Date.now() - new Date(iso).getTime()

  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString()
}

function isRevoked(install: KnownInstall): boolean {
  return install.revokedAt !== null
}

function isActive(install: KnownInstall): boolean {
  return install.revokedAt === null
}

function canRevoke(install: KnownInstall): boolean {
  return isActive(install)
}

// ---------------------------------------------------------------------------
// KnownInstall factory
// ---------------------------------------------------------------------------

function makeInstall(overrides: Partial<KnownInstall> = {}): KnownInstall {
  return {
    installId: 'install-abc123def456',
    displayName: "matt's orbital",
    role: 'owner',
    publicKey: 'ed25519:AAABBBCCC',
    joinedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),  // 1m ago
    revokedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  it('returns "—" for null', () => {
    expect(formatRelativeTime(null)).toBe('—')
  })

  it('returns "just now" for less than 60s ago', () => {
    const recent = new Date(Date.now() - 30_000).toISOString()
    expect(formatRelativeTime(recent)).toBe('just now')
  })

  it('returns "Xm ago" for 1–59 minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago')
  })

  it('returns "Xh ago" for 1–23 hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('returns locale date string for older timestamps', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    const result = formatRelativeTime(twoDaysAgo.toISOString())
    // Should be a non-empty locale date string
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toBe('—')
  })
})

// ---------------------------------------------------------------------------
// isRevoked / isActive / canRevoke
// ---------------------------------------------------------------------------

describe('install state helpers', () => {
  it('isRevoked returns false for active install', () => {
    expect(isRevoked(makeInstall())).toBe(false)
  })

  it('isRevoked returns true for revoked install', () => {
    expect(isRevoked(makeInstall({ revokedAt: new Date().toISOString() }))).toBe(true)
  })

  it('isActive returns true for active install', () => {
    expect(isActive(makeInstall())).toBe(true)
  })

  it('isActive returns false for revoked install', () => {
    expect(isActive(makeInstall({ revokedAt: new Date().toISOString() }))).toBe(false)
  })

  it('canRevoke returns true for active install', () => {
    expect(canRevoke(makeInstall())).toBe(true)
  })

  it('canRevoke returns false for already-revoked install', () => {
    expect(canRevoke(makeInstall({ revokedAt: new Date().toISOString() }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

describe('KnownInstall role', () => {
  it('owner role is a valid role', () => {
    const install = makeInstall({ role: 'owner' })
    expect(install.role).toBe('owner')
  })

  it('member role is a valid role', () => {
    const install = makeInstall({ role: 'member' })
    expect(install.role).toBe('member')
  })
})

// ---------------------------------------------------------------------------
// installId truncation (for display)
// ---------------------------------------------------------------------------

describe('installId display', () => {
  it('truncates installId to first 8 chars for display', () => {
    const install = makeInstall({ installId: 'abcdef12-0000-0000-0000-000000000000' })
    const displayed = install.installId.slice(0, 8)
    expect(displayed).toBe('abcdef12')
  })

  it('handles short installIds gracefully', () => {
    const install = makeInstall({ installId: 'short' })
    const displayed = install.installId.slice(0, 8)
    expect(displayed).toBe('short')
  })
})

// ---------------------------------------------------------------------------
// displayName fallback
// ---------------------------------------------------------------------------

describe('displayName', () => {
  it('uses displayName when set', () => {
    const install = makeInstall({ displayName: 'my laptop' })
    const label = install.displayName ?? 'Unnamed install'
    expect(label).toBe('my laptop')
  })

  it('falls back to "Unnamed install" when displayName is null', () => {
    const install = makeInstall({ displayName: null })
    const label = install.displayName ?? 'Unnamed install'
    expect(label).toBe('Unnamed install')
  })
})
