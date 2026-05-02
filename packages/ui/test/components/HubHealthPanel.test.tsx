/**
 * HubHealthPanel unit tests — pure logic layer.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Tests the pure helper functions from HubHealthPanel (formatUptime)
 * plus shape validation of the HubHealth API response type.
 *
 * @testing-library/react is not configured in this package.
 * We test pure logic helpers only.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from HealthPanel.tsx)
// ---------------------------------------------------------------------------

function formatUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h}h ${mm}m`
}

// ---------------------------------------------------------------------------
// HubHealth shape
// ---------------------------------------------------------------------------

interface HubHealth {
  mode: string
  version: string
  uptime: number
  timestamp: string
  db: { status: 'ok' | 'down'; detail?: string }
  tenantCount: number
}

function isValidHubHealth(data: unknown): data is HubHealth {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return (
    d['mode'] === 'hub' &&
    typeof d['version'] === 'string' &&
    typeof d['uptime'] === 'number' &&
    typeof d['timestamp'] === 'string' &&
    typeof d['db'] === 'object' &&
    d['db'] !== null &&
    ['ok', 'down'].includes((d['db'] as Record<string, unknown>)['status'] as string) &&
    typeof d['tenantCount'] === 'number'
  )
}

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  it('formats seconds under 1 minute', () => {
    expect(formatUptime(0)).toBe('0s')
    expect(formatUptime(1)).toBe('1s')
    expect(formatUptime(59)).toBe('59s')
    expect(formatUptime(59.9)).toBe('60s')
  })

  it('formats seconds as minutes and seconds (1–59 min range)', () => {
    expect(formatUptime(60)).toBe('1m 0s')
    expect(formatUptime(61)).toBe('1m 1s')
    expect(formatUptime(90)).toBe('1m 30s')
    expect(formatUptime(3599)).toBe('59m 59s')
  })

  it('formats seconds as hours and minutes (60+ min range)', () => {
    expect(formatUptime(3600)).toBe('1h 0m')
    expect(formatUptime(3660)).toBe('1h 1m')
    expect(formatUptime(7200)).toBe('2h 0m')
    expect(formatUptime(86399)).toBe('23h 59m')
  })

  it('handles fractional seconds', () => {
    expect(formatUptime(1.4)).toBe('1s')
    expect(formatUptime(1.5)).toBe('2s')
    expect(formatUptime(90.5)).toBe('1m 31s')
  })
})

// ---------------------------------------------------------------------------
// HubHealth shape validation
// ---------------------------------------------------------------------------

describe('isValidHubHealth', () => {
  it('accepts a valid hub health response', () => {
    const data: HubHealth = {
      mode: 'hub',
      version: '1.0.0',
      uptime: 3600,
      timestamp: new Date().toISOString(),
      db: { status: 'ok' },
      tenantCount: 2,
    }
    expect(isValidHubHealth(data)).toBe(true)
  })

  it('accepts db.status=down with detail', () => {
    const data: HubHealth = {
      mode: 'hub',
      version: '1.0.0',
      uptime: 100,
      timestamp: new Date().toISOString(),
      db: { status: 'down', detail: 'connection refused' },
      tenantCount: 0,
    }
    expect(isValidHubHealth(data)).toBe(true)
  })

  it('rejects non-hub mode', () => {
    const data = {
      mode: 'local',
      version: '1.0.0',
      uptime: 100,
      timestamp: new Date().toISOString(),
      db: { status: 'ok' },
      tenantCount: 0,
    }
    expect(isValidHubHealth(data)).toBe(false)
  })

  it('rejects invalid db status', () => {
    const data = {
      mode: 'hub',
      version: '1.0.0',
      uptime: 100,
      timestamp: new Date().toISOString(),
      db: { status: 'degraded' },
      tenantCount: 0,
    }
    expect(isValidHubHealth(data)).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidHubHealth(null)).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(isValidHubHealth({ mode: 'hub' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HubHealth tenant count
// ---------------------------------------------------------------------------

describe('HubHealth tenant count', () => {
  it('allows tenantCount=0 (empty hub)', () => {
    const data: HubHealth = {
      mode: 'hub',
      version: '1.0.0',
      uptime: 10,
      timestamp: new Date().toISOString(),
      db: { status: 'ok' },
      tenantCount: 0,
    }
    expect(isValidHubHealth(data)).toBe(true)
    expect(data.tenantCount).toBe(0)
  })

  it('allows high tenant count', () => {
    const data: HubHealth = {
      mode: 'hub',
      version: '1.0.0',
      uptime: 10,
      timestamp: new Date().toISOString(),
      db: { status: 'ok' },
      tenantCount: 1000,
    }
    expect(isValidHubHealth(data)).toBe(true)
  })
})
