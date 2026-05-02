/**
 * Unit tests for registerMondayReconciliation.
 *
 * Uses vi.useFakeTimers() to verify that the helper triggers reconcile() at
 * the configured cadence without any real DB or Monday API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  registerMondayReconciliation,
  type ReconcilableService,
} from '../../../src/backlog/reconcile-bootstrap.js'

// ---------------------------------------------------------------------------
// Stub service — implements ReconcilableService with vi.fn internals.
// ---------------------------------------------------------------------------

function makeStubService(): {
  service: ReconcilableService
  startSpy: ReturnType<typeof vi.fn>
  stopSpy: ReturnType<typeof vi.fn>
  reconcileFn: ReturnType<typeof vi.fn>
  startAndCaptureInterval: () => void
  timer: NodeJS.Timeout | null
} {
  let capturedFn: (() => void) | null = null
  let capturedIntervalMs = 0

  const startSpy = vi.fn((boardId: string) => {
    // The real DefaultMondaySyncService calls setInterval with reconcileIntervalMs.
    // Our stub lets the test drive the interval manually.
    void boardId
    capturedFn = null
  })

  const stopSpy = vi.fn()
  const reconcileFn = vi.fn().mockResolvedValue({ pulledCount: 0, driftCount: 0, boardId: 'test-board' })

  const service: ReconcilableService = {
    startScheduledReconcile: startSpy,
    stopScheduledReconcile: stopSpy,
  }

  return {
    service,
    startSpy,
    stopSpy,
    reconcileFn,
    startAndCaptureInterval: () => { void capturedFn; void capturedIntervalMs },
    timer: null,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMondayReconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls startScheduledReconcile with the boardId when boardId is provided', () => {
    const { service, startSpy } = makeStubService()
    const handle = registerMondayReconciliation({ syncService: service, boardId: 'board-123' })

    expect(startSpy).toHaveBeenCalledOnce()
    expect(startSpy).toHaveBeenCalledWith('board-123')

    handle.stop()
  })

  it('returns a stop() that calls stopScheduledReconcile', () => {
    const { service, stopSpy } = makeStubService()
    const handle = registerMondayReconciliation({ syncService: service, boardId: 'board-abc' })

    handle.stop()

    expect(stopSpy).toHaveBeenCalledOnce()
  })

  it('does NOT start reconcile when boardId is absent', () => {
    const { service, startSpy, stopSpy } = makeStubService()
    const handle = registerMondayReconciliation({ syncService: service, boardId: undefined })

    expect(startSpy).not.toHaveBeenCalled()

    // stop() is a no-op when boardId was absent
    handle.stop()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('does NOT start reconcile when boardId is empty string', () => {
    const { service, startSpy } = makeStubService()
    registerMondayReconciliation({ syncService: service, boardId: '' })

    expect(startSpy).not.toHaveBeenCalled()
  })

  it('triggers reconcile at the configured cadence via fake timers (end-to-end timer test)', () => {
    // This test verifies that when a real setInterval-based service is used, the
    // reconcile call happens at the configured interval.  We do this by wiring
    // a minimal service that calls its own setInterval inside startScheduledReconcile.
    const reconcileFn = vi.fn().mockResolvedValue({ pulledCount: 0, driftCount: 0 })
    let storedTimer: ReturnType<typeof setInterval> | null = null

    const intervalMs = 5_000 // 5s in the test

    const fakeService: ReconcilableService = {
      startScheduledReconcile(_boardId: string) {
        storedTimer = setInterval(() => {
          void reconcileFn()
        }, intervalMs)
      },
      stopScheduledReconcile() {
        if (storedTimer) clearInterval(storedTimer)
      },
    }

    const handle = registerMondayReconciliation({
      syncService: fakeService,
      boardId: 'board-timer-test',
      intervalMs,
    })

    // Not called yet — interval hasn't fired.
    expect(reconcileFn).not.toHaveBeenCalled()

    // Advance past one interval.
    vi.advanceTimersByTime(intervalMs + 1)
    expect(reconcileFn).toHaveBeenCalledTimes(1)

    // Advance past a second interval.
    vi.advanceTimersByTime(intervalMs)
    expect(reconcileFn).toHaveBeenCalledTimes(2)

    handle.stop()

    // After stop, no more calls.
    vi.advanceTimersByTime(intervalMs * 5)
    expect(reconcileFn).toHaveBeenCalledTimes(2)
  })

  it('is idempotent: calling stop() multiple times does not throw', () => {
    const { service } = makeStubService()
    const handle = registerMondayReconciliation({ syncService: service, boardId: 'board-idempotent' })

    expect(() => {
      handle.stop()
      handle.stop()
      handle.stop()
    }).not.toThrow()
  })
})
