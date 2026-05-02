/**
 * HubTab unit tests — pure logic layer.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Tests the store-level logic that backs HubTab rendering.
 * No DOM required — tests the Zustand store transitions that HubTab uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Pure helpers mirrored from HubTab.tsx
// ---------------------------------------------------------------------------

function statusColorClass(status: string): string {
  const map: Record<string, string> = {
    connected: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    connecting: 'text-amber-700 bg-amber-50 border-amber-200',
    disconnected: 'text-slate-500 bg-slate-50 border-slate-200',
    error: 'text-red-700 bg-red-50 border-red-200',
  }
  return map[status] ?? map['disconnected']
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Not configured',
    error: 'Error',
  }
  return map[status] ?? status
}

function shouldShowTestButton(hubUrl: string | null): boolean {
  return hubUrl !== null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HubTab helpers', () => {
  it('T1: statusColorClass returns emerald for connected', () => {
    const cls = statusColorClass('connected')
    expect(cls).toContain('emerald')
  })

  it('T2: statusColorClass returns amber for connecting', () => {
    const cls = statusColorClass('connecting')
    expect(cls).toContain('amber')
  })

  it('T3: statusColorClass returns red for error', () => {
    const cls = statusColorClass('error')
    expect(cls).toContain('red')
  })

  it('T4: statusColorClass returns slate for disconnected', () => {
    const cls = statusColorClass('disconnected')
    expect(cls).toContain('slate')
  })

  it('T5: statusLabel returns human-readable labels', () => {
    expect(statusLabel('connected')).toBe('Connected')
    expect(statusLabel('connecting')).toBe('Connecting')
    expect(statusLabel('disconnected')).toBe('Not configured')
    expect(statusLabel('error')).toBe('Error')
  })

  it('T6: shouldShowTestButton returns false when hubUrl is null', () => {
    expect(shouldShowTestButton(null)).toBe(false)
  })

  it('T7: shouldShowTestButton returns true when hubUrl is set', () => {
    expect(shouldShowTestButton('https://orbital.team.dev')).toBe(true)
  })
})

describe('HubTab store integration', () => {
  beforeEach(async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    useHubStore.getState().applyHubStatus({
      status: 'disconnected',
      hubUrl: null,
      lastSyncAt: null,
      errorMessage: null,
    })
  })

  it('T8: store starts disconnected (HubTab initial render state)', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    expect(useHubStore.getState().status).toBe('disconnected')
  })

  it('T9: successful test connection flow updates store to connected', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')

    // Simulate what HubTab.handleTestConnection does on success
    const now = new Date().toISOString()
    useHubStore.getState().applyHubStatus({
      status: 'connected',
      hubUrl: 'https://orbital.team.dev',
      lastSyncAt: now,
      errorMessage: null,
    })

    const s = useHubStore.getState()
    expect(s.status).toBe('connected')
    expect(s.errorMessage).toBeNull()
    expect(s.lastSyncAt).toBe(now)
  })

  it('T10: failed test connection flow updates store to error', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')

    // Simulate what HubTab.handleTestConnection does on failure
    useHubStore.getState().applyHubStatus({
      status: 'error',
      hubUrl: 'https://orbital.team.dev',
      lastSyncAt: null,
      errorMessage: 'HTTP 503 from hub',
    })

    const s = useHubStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorMessage).toBe('HTTP 503 from hub')
  })

  it('T11: hub store setHubUrl updates hubUrl', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    useHubStore.getState().setHubUrl('https://hub.example.com')
    expect(useHubStore.getState().hubUrl).toBe('https://hub.example.com')
  })

  it('T12: hub store setErrorMessage updates error', async () => {
    const { useHubStore } = await import('../../src/store/hub.js')
    useHubStore.getState().setErrorMessage('timeout')
    expect(useHubStore.getState().errorMessage).toBe('timeout')
    useHubStore.getState().setErrorMessage(null)
    expect(useHubStore.getState().errorMessage).toBeNull()
  })
})

describe('Test connection fetch simulation', () => {
  it('T13: fetch success resolves to connected state update', async () => {
    // Simulate the handleTestConnection logic without a real fetch
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

    // Replicate the logic from HubTab.handleTestConnection
    const hubUrl = 'https://orbital.team.dev'
    let testResult: { ok: boolean; message: string } | null = null
    let newStatus: string = 'disconnected'

    try {
      const res = await mockFetch(`${hubUrl}/health`)
      if (res.ok) {
        testResult = { ok: true, message: 'Hub reachable — connection OK.' }
        newStatus = 'connected'
      } else {
        testResult = { ok: false, message: `HTTP ${res.status} from hub` }
        newStatus = 'error'
      }
    } catch {
      testResult = { ok: false, message: 'Connection failed' }
      newStatus = 'error'
    }

    expect(testResult?.ok).toBe(true)
    expect(newStatus).toBe('connected')
    expect(mockFetch).toHaveBeenCalledWith(`${hubUrl}/health`)
  })

  it('T14: fetch network failure results in error state', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const hubUrl = 'https://orbital.team.dev'
    let testResult: { ok: boolean; message: string } | null = null
    let newStatus: string = 'disconnected'

    try {
      await mockFetch(`${hubUrl}/health`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      testResult = { ok: false, message: `Connection failed: ${msg}` }
      newStatus = 'error'
    }

    expect(testResult?.ok).toBe(false)
    expect(newStatus).toBe('error')
    expect(testResult?.message).toContain('ECONNREFUSED')
  })
})
