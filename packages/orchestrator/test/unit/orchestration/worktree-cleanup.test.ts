/**
 * Unit tests for registerWorktreeCleanup.
 *
 * No real DB, no real git — stubs for EventStore and WorktreeManager.
 * Verifies the subscription/dispatch/cleanup logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerWorktreeCleanup } from '../../../src/orchestration/worktree-cleanup.js'
import type { EventStore } from '../../../src/events/store.js'
import type { IWorktreeManager } from '../../../src/orchestration/worktree.js'
import type { EventEnvelope } from '../../../src/events/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SubscribeHandler = (event: EventEnvelope) => void

function makeEnvelope(
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    event_id: 'evt-001',
    aggregate_id: 'task-001',
    aggregate_type: 'task',
    event_type: 'TaskCompleted',
    payload: {},
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: 'trace-001',
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
    ...overrides,
  }
}

function makeEventStore(): {
  store: EventStore
  capturedHandlers: SubscribeHandler[]
  appendSpy: ReturnType<typeof vi.fn>
  unsubscribeSpy: ReturnType<typeof vi.fn>
  emit(event: EventEnvelope): void
} {
  const capturedHandlers: SubscribeHandler[] = []
  const appendSpy = vi.fn().mockResolvedValue(makeEnvelope())
  const unsubscribeSpy = vi.fn()

  const store: EventStore = {
    append: appendSpy,
    query: vi.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false }),
    subscribe(_cursor, handler) {
      capturedHandlers.push(handler)
      return unsubscribeSpy
    },
  }

  return {
    store,
    capturedHandlers,
    appendSpy,
    unsubscribeSpy,
    emit(event) {
      capturedHandlers.forEach((h) => h(event))
    },
  }
}

function makeWorktreeManager(): {
  manager: IWorktreeManager
  cleanupSpy: ReturnType<typeof vi.fn>
} {
  const cleanupSpy = vi.fn().mockResolvedValue(undefined)
  const manager: IWorktreeManager = {
    create: vi.fn(),
    cleanup: cleanupSpy,
    conflict: vi.fn().mockReturnValue(false),
    getActiveWorktrees: vi.fn().mockResolvedValue([]),
  }
  return { manager, cleanupSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerWorktreeCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('subscribes to the event store on register', () => {
    const { store, capturedHandlers } = makeEventStore()
    const { manager } = makeWorktreeManager()
    const fakeDb = {} as Parameters<typeof registerWorktreeCleanup>[0]['db']

    registerWorktreeCleanup({ eventStore: store, worktreeManager: manager, db: fakeDb })
    expect(capturedHandlers).toHaveLength(1)
  })

  it('calls cleanup when TaskCompleted fires', async () => {
    const { store, cleanupSpy, emit } = Object.assign(
      makeEventStore(),
      makeWorktreeManager(),
    )
    const { manager, cleanupSpy: cs } = makeWorktreeManager()
    const { store: s, emit: e } = makeEventStore()

    registerWorktreeCleanup({ eventStore: s, worktreeManager: manager, db: {} as never })

    const event = makeEnvelope({ event_type: 'TaskCompleted', aggregate_id: 'task-xyz' })
    e(event)

    // Allow microtasks to settle.
    await vi.waitFor(() => expect(cs).toHaveBeenCalledWith('task-xyz'))
    void store; void cleanupSpy; void emit
  })

  it('calls cleanup when TaskFailed fires', async () => {
    const { manager, cleanupSpy } = makeWorktreeManager()
    const { store, emit } = makeEventStore()

    registerWorktreeCleanup({ eventStore: store, worktreeManager: manager, db: {} as never })

    const event = makeEnvelope({ event_type: 'TaskFailed', aggregate_id: 'task-fail-001' })
    emit(event)

    await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledWith('task-fail-001'))
  })

  it('does NOT call cleanup for unrelated events', async () => {
    const { manager, cleanupSpy } = makeWorktreeManager()
    const { store, emit } = makeEventStore()

    registerWorktreeCleanup({ eventStore: store, worktreeManager: manager, db: {} as never })

    emit(makeEnvelope({ event_type: 'TaskStarted', aggregate_id: 'task-start' }))
    emit(makeEnvelope({ event_type: 'AgentSpawned', aggregate_id: 'task-spawn' }))
    emit(makeEnvelope({ event_type: 'SprintStarted', aggregate_id: 'sprint-1' }))

    // Let any async ops settle — cleanup must still be zero.
    await new Promise((r) => setTimeout(r, 10))
    expect(cleanupSpy).not.toHaveBeenCalled()
  })

  it('is non-fatal when cleanup throws: logs + attempts WorktreeCleanupFailed event', async () => {
    const { manager, cleanupSpy } = makeWorktreeManager()
    cleanupSpy.mockRejectedValueOnce(new Error('git error'))

    const { store, appendSpy, emit } = makeEventStore()

    registerWorktreeCleanup({ eventStore: store, worktreeManager: manager, db: {} as never })

    emit(makeEnvelope({ event_type: 'TaskCompleted', aggregate_id: 'task-boom' }))

    // Append is called with the WorktreeCleanupFailed event.
    await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled())
    const call = appendSpy.mock.calls[0]?.[0] as { event_type?: string; aggregate_id?: string } | undefined
    expect(call?.event_type).toBe('WorktreeCleanupFailed')
    expect(call?.aggregate_id).toBe('task-boom')
  })

  it('does not throw when WorktreeCleanupFailed append itself throws', async () => {
    const { manager, cleanupSpy } = makeWorktreeManager()
    cleanupSpy.mockRejectedValueOnce(new Error('git remove failed'))

    const { store, appendSpy, emit } = makeEventStore()
    appendSpy.mockRejectedValueOnce(new Error('event type not in catalog'))

    registerWorktreeCleanup({ eventStore: store, worktreeManager: manager, db: {} as never })

    // Should not propagate the error.
    await expect(async () => {
      emit(makeEnvelope({ event_type: 'TaskCompleted', aggregate_id: 'task-double-fail' }))
      await new Promise((r) => setTimeout(r, 20))
    }).not.toThrow()
  })

  it('stop() calls the unsubscribe function returned by eventStore.subscribe', () => {
    const { store, unsubscribeSpy } = makeEventStore()
    const { manager } = makeWorktreeManager()

    const handle = registerWorktreeCleanup({
      eventStore: store,
      worktreeManager: manager,
      db: {} as never,
    })
    handle.stop()

    expect(unsubscribeSpy).toHaveBeenCalledOnce()
  })
})
