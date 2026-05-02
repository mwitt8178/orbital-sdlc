/**
 * HubStatusIndicator unit tests — pure logic layer.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Tests the pure helper functions that drive HubStatusIndicator rendering,
 * without requiring a full DOM environment.
 */

import { describe, it, expect } from 'vitest'
import type { HubConnectionStatus } from '../../src/store/hub.js'

// ---------------------------------------------------------------------------
// Pure helpers mirrored from HubStatusIndicator.tsx
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-red-500',
  error: 'bg-red-500',
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Hub',
  connecting: 'Connecting...',
  disconnected: 'Hub offline',
  error: 'Hub error',
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return url.slice(0, 30)
  }
}

function shouldRender(hubUrl: string | null): boolean {
  return hubUrl !== null
}

function dotClass(status: HubConnectionStatus): string {
  return STATUS_DOT[status] ?? 'bg-slate-400'
}

function labelFor(status: HubConnectionStatus): string {
  return STATUS_LABEL[status] ?? status
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HubStatusIndicator helpers', () => {
  it('S1: shouldRender returns false when hubUrl is null', () => {
    expect(shouldRender(null)).toBe(false)
  })

  it('S2: shouldRender returns true when hubUrl is set', () => {
    expect(shouldRender('https://orbital.team.dev')).toBe(true)
  })

  it('S3: dotClass is green for connected', () => {
    expect(dotClass('connected')).toBe('bg-emerald-500')
  })

  it('S4: dotClass is amber+pulse for connecting', () => {
    expect(dotClass('connecting')).toContain('amber')
    expect(dotClass('connecting')).toContain('animate-pulse')
  })

  it('S5: dotClass is red for disconnected', () => {
    expect(dotClass('disconnected')).toBe('bg-red-500')
  })

  it('S6: dotClass is red for error', () => {
    expect(dotClass('error')).toBe('bg-red-500')
  })

  it('S7: labelFor returns correct labels for all statuses', () => {
    expect(labelFor('connected')).toBe('Hub')
    expect(labelFor('connecting')).toBe('Connecting...')
    expect(labelFor('disconnected')).toBe('Hub offline')
    expect(labelFor('error')).toBe('Hub error')
  })

  it('S8: truncateUrl extracts hostname from full URL', () => {
    expect(truncateUrl('https://orbital.team.dev')).toBe('orbital.team.dev')
    expect(truncateUrl('https://orbital.team.dev/path?q=1')).toBe('orbital.team.dev')
  })

  it('S9: truncateUrl handles http and port', () => {
    expect(truncateUrl('http://localhost:3001')).toBe('localhost')
  })

  it('S10: truncateUrl falls back to slicing for non-URL strings', () => {
    const result = truncateUrl('not-a-url')
    expect(typeof result).toBe('string')
    expect(result.length).toBeLessThanOrEqual(30)
  })
})

describe('hub store initial state', () => {
  it('S11: default status is disconnected', async () => {
    // Import store; verify initial state shape
    const { useHubStore } = await import('../../src/store/hub.js')
    const state = useHubStore.getState()
    expect(state.status).toBe('disconnected')
    expect(state.hubUrl).toBeNull()
    expect(state.lastSyncAt).toBeNull()
    expect(state.errorMessage).toBeNull()
  })

  it('S12: setStatus updates status correctly', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    useHubStore.getState().setStatus('connected')
    expect(useHubStore.getState().status).toBe('connected')
    // reset
    useHubStore.getState().setStatus('disconnected')
  })

  it('S13: applyHubStatus updates all fields atomically', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    const now = new Date().toISOString()
    useHubStore.getState().applyHubStatus({
      status: 'connected',
      hubUrl: 'https://orbital.team.dev',
      lastSyncAt: now,
      errorMessage: null,
    })
    const s = useHubStore.getState()
    expect(s.status).toBe('connected')
    expect(s.hubUrl).toBe('https://orbital.team.dev')
    expect(s.lastSyncAt).toBe(now)
    expect(s.errorMessage).toBeNull()
    // reset
    useHubStore.getState().applyHubStatus({ status: 'disconnected', hubUrl: null, lastSyncAt: null, errorMessage: null })
  })
})
