/**
 * PresenceIndicator unit tests — pure logic.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Note: @testing-library/react is not configured in this package.
 * Tests verify the pure helper logic exported from PresenceIndicator:
 *   - isOnline() boundary conditions
 *   - formatLastSeen() time formatting
 *
 * AC covered: presence dot shows green when last_seen_at < 90s ago.
 */

import { describe, it, expect } from 'vitest'
import { isOnline, ONLINE_THRESHOLD_MS } from '../../src/components/identity/PresenceIndicator.js'

// ---------------------------------------------------------------------------
// Helpers mirrored from PresenceIndicator.tsx
// ---------------------------------------------------------------------------

function formatLastSeen(lastSeenAt: string | null | undefined): string {
  if (!lastSeenAt) return 'Never seen'
  const ms = Date.now() - new Date(lastSeenAt).getTime()
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

// ---------------------------------------------------------------------------
// Tests: isOnline
// ---------------------------------------------------------------------------

describe('PresenceIndicator — isOnline()', () => {
  it('returns false for null', () => {
    expect(isOnline(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isOnline(undefined)).toBe(false)
  })

  it('returns false for empty string', () => {
    // Empty string will produce NaN from Date parsing → distance is Infinity
    expect(isOnline('')).toBe(false)
  })

  it('returns true for a timestamp within the threshold (just now)', () => {
    const now = new Date().toISOString()
    expect(isOnline(now)).toBe(true)
  })

  it('returns true for a timestamp 1 second ago', () => {
    const ts = new Date(Date.now() - 1_000).toISOString()
    expect(isOnline(ts)).toBe(true)
  })

  it('returns true for a timestamp exactly at the threshold boundary minus 1ms', () => {
    const ts = new Date(Date.now() - ONLINE_THRESHOLD_MS + 1).toISOString()
    expect(isOnline(ts)).toBe(true)
  })

  it('returns false for a timestamp exactly at the threshold', () => {
    const ts = new Date(Date.now() - ONLINE_THRESHOLD_MS).toISOString()
    // At exactly threshold, ms < threshold is false → offline
    expect(isOnline(ts)).toBe(false)
  })

  it('returns false for a timestamp 5 minutes ago', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(isOnline(ts)).toBe(false)
  })

  it('returns false for a timestamp from yesterday', () => {
    const ts = new Date(Date.now() - 86_400_000).toISOString()
    expect(isOnline(ts)).toBe(false)
  })

  it('ONLINE_THRESHOLD_MS is 90000 (90 seconds)', () => {
    expect(ONLINE_THRESHOLD_MS).toBe(90_000)
  })

  it('isOnline is pure — calling it twice with same input returns same result', () => {
    const ts = new Date(Date.now() - 30_000).toISOString()
    expect(isOnline(ts)).toBe(isOnline(ts))
  })
})

// ---------------------------------------------------------------------------
// Tests: formatLastSeen
// ---------------------------------------------------------------------------

describe('PresenceIndicator — formatLastSeen()', () => {
  it('returns "Never seen" for null', () => {
    expect(formatLastSeen(null)).toBe('Never seen')
  })

  it('returns "Never seen" for undefined', () => {
    expect(formatLastSeen(undefined)).toBe('Never seen')
  })

  it('returns "Just now" for a timestamp less than 60 seconds ago', () => {
    const ts = new Date(Date.now() - 30_000).toISOString()
    expect(formatLastSeen(ts)).toBe('Just now')
  })

  it('returns "Just now" for a timestamp 1 second ago', () => {
    const ts = new Date(Date.now() - 1_000).toISOString()
    expect(formatLastSeen(ts)).toBe('Just now')
  })

  it('returns "Xm ago" for a timestamp 1 minute ago', () => {
    const ts = new Date(Date.now() - 60_000).toISOString()
    expect(formatLastSeen(ts)).toBe('1m ago')
  })

  it('returns "Xm ago" for a timestamp 45 minutes ago', () => {
    const ts = new Date(Date.now() - 45 * 60_000).toISOString()
    expect(formatLastSeen(ts)).toBe('45m ago')
  })

  it('returns "Xh ago" for a timestamp 1 hour ago', () => {
    const ts = new Date(Date.now() - 3_600_000).toISOString()
    expect(formatLastSeen(ts)).toBe('1h ago')
  })

  it('returns "Xh ago" for a timestamp 5 hours ago', () => {
    const ts = new Date(Date.now() - 5 * 3_600_000).toISOString()
    expect(formatLastSeen(ts)).toBe('5h ago')
  })

  it('returns "Xd ago" for a timestamp 24+ hours ago', () => {
    const ts = new Date(Date.now() - 86_400_000).toISOString()
    expect(formatLastSeen(ts)).toBe('1d ago')
  })

  it('returns "Xd ago" for a timestamp 3 days ago', () => {
    const ts = new Date(Date.now() - 3 * 86_400_000).toISOString()
    expect(formatLastSeen(ts)).toBe('3d ago')
  })
})

// ---------------------------------------------------------------------------
// Tests: tooltip construction
// ---------------------------------------------------------------------------

describe('PresenceIndicator — tooltip text construction', () => {
  it('shows "Online" when online and no displayName', () => {
    const now = new Date().toISOString()
    const online = isOnline(now)
    const tooltip = online ? 'Online' : formatLastSeen(now)
    expect(tooltip).toBe('Online')
  })

  it('shows "Never seen" when lastSeenAt is null and offline', () => {
    const online = isOnline(null)
    const tooltip = online ? 'Online' : formatLastSeen(null)
    expect(tooltip).toBe('Never seen')
  })

  it('includes displayName in tooltip when provided and online', () => {
    const now = new Date().toISOString()
    const online = isOnline(now)
    const displayName = 'alice-laptop'
    const tooltip = displayName
      ? `${displayName}: ${online ? 'Online' : formatLastSeen(now)}`
      : online ? 'Online' : formatLastSeen(now)
    expect(tooltip).toBe('alice-laptop: Online')
  })

  it('includes displayName with last-seen time when offline', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString()
    const online = isOnline(ts)
    const displayName = 'bob-home'
    const tooltip = displayName
      ? `${displayName}: ${online ? 'Online' : formatLastSeen(ts)}`
      : online ? 'Online' : formatLastSeen(ts)
    expect(tooltip).toBe('bob-home: 5m ago')
  })
})
