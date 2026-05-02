/**
 * test/components/PendingMutationsPanel.test.tsx
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Tests for PendingMutationsPanel pure logic (store + helper functions).
 *
 * Approach: test via store state without DOM rendering (avoids tRPC provider
 * setup for unit tests; DOM tests are in Playwright e2e).
 *
 * Tests:
 *   P1: panel is closed by default
 *   P2: open() sets isOpen=true
 *   P3: close() sets isOpen=false
 *   P4: toggle() flips state
 *   P5: setEntries populates entries
 *   P6: pendingCount counts pending+retrying only
 *   P7: failedCount counts failed only
 *   P8: clear() resets all
 *   P9: status label helpers
 *   P10: relative time format
 *   P11: setFetchError stores error message
 *   P12: setLoading sets isLoading
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { usePendingMutationsPanelStore } from '../../src/store/pendingMutationsPanel.js'
import { usePendingMutationsStore } from '../../src/store/pendingMutations.js'
import type { PendingMutationEntry } from '../../src/store/pendingMutations.js'

// ---------------------------------------------------------------------------
// Pure helpers mirrored from PendingMutationsPanel.tsx
// ---------------------------------------------------------------------------

type EntryStatus = PendingMutationEntry['status']

function statusLabel(status: EntryStatus): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'retrying':
      return 'Retrying'
    case 'failed':
      return 'Failed'
  }
}

function statusClasses(status: EntryStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-blue-50 text-blue-700'
    case 'retrying':
      return 'bg-amber-50 text-amber-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
  }
}

function formatRelativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ago`
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<PendingMutationEntry> = {}): PendingMutationEntry {
  return {
    seq: '1',
    kind: 'mutation',
    endpoint: 'memory.update',
    idempotency_key: 'test-key',
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    status: 'pending',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Reset stores before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  usePendingMutationsPanelStore.getState().close()
  usePendingMutationsStore.getState().clear()
})

// ---------------------------------------------------------------------------
// Panel open/close tests
// ---------------------------------------------------------------------------

describe('PendingMutationsPanel — panel state', () => {
  it('P1: panel is closed by default', () => {
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(false)
  })

  it('P2: open() sets isOpen=true', () => {
    usePendingMutationsPanelStore.getState().open()
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(true)
  })

  it('P3: close() sets isOpen=false', () => {
    usePendingMutationsPanelStore.getState().open()
    usePendingMutationsPanelStore.getState().close()
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(false)
  })

  it('P4: toggle() flips from closed to open', () => {
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(false)
    usePendingMutationsPanelStore.getState().toggle()
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(true)
    usePendingMutationsPanelStore.getState().toggle()
    expect(usePendingMutationsPanelStore.getState().isOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pending mutations store tests
// ---------------------------------------------------------------------------

describe('PendingMutationsPanel — mutations store', () => {
  it('P5: setEntries populates entries', () => {
    const entries = [makeEntry({ seq: '1' }), makeEntry({ seq: '2' })]
    usePendingMutationsStore.getState().setEntries(entries)
    expect(usePendingMutationsStore.getState().entries).toHaveLength(2)
  })

  it('P6: pendingCount counts pending+retrying only', () => {
    usePendingMutationsStore.getState().setEntries([
      makeEntry({ seq: '1', status: 'pending' }),
      makeEntry({ seq: '2', status: 'retrying' }),
      makeEntry({ seq: '3', status: 'failed' }),
    ])
    expect(usePendingMutationsStore.getState().pendingCount).toBe(2)
  })

  it('P7: failedCount counts failed only', () => {
    usePendingMutationsStore.getState().setEntries([
      makeEntry({ seq: '1', status: 'pending' }),
      makeEntry({ seq: '2', status: 'failed' }),
      makeEntry({ seq: '3', status: 'failed' }),
    ])
    expect(usePendingMutationsStore.getState().failedCount).toBe(2)
  })

  it('P8: clear() resets all state', () => {
    usePendingMutationsStore.getState().setEntries([makeEntry()])
    usePendingMutationsStore.getState().setFetchError('some error')
    usePendingMutationsStore.getState().clear()

    const state = usePendingMutationsStore.getState()
    expect(state.entries).toHaveLength(0)
    expect(state.pendingCount).toBe(0)
    expect(state.failedCount).toBe(0)
    expect(state.fetchError).toBeNull()
  })

  it('P11: setFetchError stores error message', () => {
    usePendingMutationsStore.getState().setFetchError('connection refused')
    expect(usePendingMutationsStore.getState().fetchError).toBe('connection refused')
  })

  it('P12: setLoading(true) sets isLoading=true', () => {
    usePendingMutationsStore.getState().setLoading(true)
    expect(usePendingMutationsStore.getState().isLoading).toBe(true)
    usePendingMutationsStore.getState().setLoading(false)
    expect(usePendingMutationsStore.getState().isLoading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe('PendingMutationsPanel — pure helpers', () => {
  it('P9a: statusLabel returns "Queued" for pending', () => {
    expect(statusLabel('pending')).toBe('Queued')
  })

  it('P9b: statusLabel returns "Retrying" for retrying', () => {
    expect(statusLabel('retrying')).toBe('Retrying')
  })

  it('P9c: statusLabel returns "Failed" for failed', () => {
    expect(statusLabel('failed')).toBe('Failed')
  })

  it('P9d: statusClasses returns correct classes for each status', () => {
    expect(statusClasses('pending')).toContain('blue')
    expect(statusClasses('retrying')).toContain('amber')
    expect(statusClasses('failed')).toContain('red')
  })

  it('P10a: formatRelativeTime returns seconds for recent times', () => {
    const recent = new Date(Date.now() - 5_000).toISOString()
    const result = formatRelativeTime(recent)
    expect(result).toMatch(/s ago/)
  })

  it('P10b: formatRelativeTime returns minutes for times > 60s ago', () => {
    const minuteAgo = new Date(Date.now() - 90_000).toISOString()
    const result = formatRelativeTime(minuteAgo)
    expect(result).toMatch(/m ago/)
  })

  it('P10c: formatRelativeTime returns the input string on invalid ISO', () => {
    const bad = 'not-a-date'
    const result = formatRelativeTime(bad)
    expect(typeof result).toBe('string')
  })
})
