/**
 * test/hooks/useHubConnection.test.tsx
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * Tests for the useHubConnection hook.
 *
 * Approach: test pure logic by manipulating the Zustand stores that the hook
 * reads from, then asserting the derived state matches expectations.
 *
 * We test the logic of what the hook *should* return by verifying the store
 * state directly and by testing the pure derivation logic. Full DOM rendering
 * tests (rendering the hook in a component) are in Playwright e2e.
 *
 * Tests:
 *   H1: connected state → isDown=false
 *   H2: markDisconnected → status=disconnected
 *   H3: setIsDown(true) → isDown=true
 *   H4: pendingCount reflects store
 *   H5: failedCount reflects store
 *   H6: totalQueuedCount = pendingCount + failedCount
 *   H7: lastConnectedAt set after markConnected
 *   H8: downSince set after markDisconnected
 *   H9: isOffline derived from status + isDown
 *   H10: reconnecting → isOffline=true
 *   H11: markConnected clears isDown
 *   H12: clear() resets pending counts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useHubWsStore } from '../../src/store/hubWs.js'
import { usePendingMutationsStore } from '../../src/store/pendingMutations.js'
import type { PendingMutationEntry } from '../../src/store/pendingMutations.js'

// ---------------------------------------------------------------------------
// Pure derivation logic (mirrors useHubConnection hook logic)
// ---------------------------------------------------------------------------

function deriveIsOffline(
  isDown: boolean,
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected',
): boolean {
  return isDown || status === 'disconnected' || status === 'reconnecting'
}

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
// Reset stores between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  const ws = useHubWsStore.getState()
  ws.markConnected()
  ws.setIsDown(false)

  const pending = usePendingMutationsStore.getState()
  pending.clear()
})

// ---------------------------------------------------------------------------
// WS store tests (what the hook reads)
// ---------------------------------------------------------------------------

describe('useHubConnection — connected state (store)', () => {
  it('H1: connected → isDown=false', () => {
    useHubWsStore.getState().markConnected()
    const { isDown } = useHubWsStore.getState()
    expect(isDown).toBe(false)
  })

  it('H2: markDisconnected → status=disconnected', () => {
    useHubWsStore.getState().markDisconnected()
    expect(useHubWsStore.getState().status).toBe('disconnected')
  })

  it('H3: setIsDown(true) → isDown=true', () => {
    useHubWsStore.getState().setIsDown(true)
    expect(useHubWsStore.getState().isDown).toBe(true)
    // Reset
    useHubWsStore.getState().setIsDown(false)
  })
})

describe('useHubConnection — pending mutation counts (store)', () => {
  it('H4: pendingCount reflects store after setEntries', () => {
    usePendingMutationsStore.getState().setEntries([
      makeEntry({ seq: '1', status: 'pending' }),
      makeEntry({ seq: '2', status: 'retrying' }),
    ])
    // pendingCount counts pending + retrying
    expect(usePendingMutationsStore.getState().pendingCount).toBe(2)
  })

  it('H5: failedCount reflects store after setEntries with failed', () => {
    usePendingMutationsStore.getState().setEntries([
      makeEntry({ seq: '3', status: 'failed' }),
    ])
    expect(usePendingMutationsStore.getState().failedCount).toBe(1)
  })

  it('H6: totalQueuedCount = pendingCount + failedCount', () => {
    usePendingMutationsStore.getState().setEntries([
      makeEntry({ seq: '4', status: 'pending' }),
      makeEntry({ seq: '5', status: 'failed' }),
    ])
    const { pendingCount, failedCount } = usePendingMutationsStore.getState()
    expect(pendingCount + failedCount).toBe(2)
  })

  it('H7: lastConnectedAt is set after markConnected', () => {
    useHubWsStore.getState().markConnected()
    const { lastConnectedAt } = useHubWsStore.getState()
    expect(lastConnectedAt).not.toBeNull()
    expect(typeof lastConnectedAt).toBe('string')
  })

  it('H8: downSince is set after markDisconnected', () => {
    useHubWsStore.getState().markConnected()
    useHubWsStore.getState().markDisconnected()
    const { downSince } = useHubWsStore.getState()
    expect(downSince).not.toBeNull()
  })
})

describe('useHubConnection — isOffline derivation logic', () => {
  it('H9a: connected + isDown=false → isOffline=false', () => {
    expect(deriveIsOffline(false, 'connected')).toBe(false)
  })

  it('H9b: connected + isDown=true → isOffline=true', () => {
    expect(deriveIsOffline(true, 'connected')).toBe(true)
  })

  it('H10: reconnecting → isOffline=true', () => {
    useHubWsStore.getState().markReconnecting()
    const { status, isDown } = useHubWsStore.getState()
    expect(deriveIsOffline(isDown, status)).toBe(true)
  })

  it('H11: markConnected after disconnect → isOffline=false', () => {
    useHubWsStore.getState().markDisconnected()
    useHubWsStore.getState().markConnected()
    const { status, isDown } = useHubWsStore.getState()
    expect(deriveIsOffline(isDown, status)).toBe(false)
  })

  it('H12: clear() resets pending counts to 0', () => {
    usePendingMutationsStore.getState().setEntries([makeEntry()])
    usePendingMutationsStore.getState().clear()
    const { pendingCount, failedCount } = usePendingMutationsStore.getState()
    expect(pendingCount).toBe(0)
    expect(failedCount).toBe(0)
  })
})
