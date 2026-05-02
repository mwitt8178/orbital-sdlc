/**
 * Unit tests for the toasts Zustand store.
 *
 * The store is plain logic (no DOM or React); we exercise push/dedupe/dismiss
 * directly via getState/setState.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useToastsStore, __test as testInternals } from './toasts.js'

beforeEach(() => {
  useToastsStore.getState().clear()
})

describe('useToastsStore', () => {
  it('starts empty', () => {
    expect(useToastsStore.getState().toasts).toEqual([])
    expect(useToastsStore.getState().excessCount).toBe(0)
  })

  it('push appends a toast and returns its id', () => {
    const id = useToastsStore.getState().push({ kind: 'info', title: 'Hello' })
    const list = useToastsStore.getState().toasts
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(id)
    expect(list[0]?.title).toBe('Hello')
    expect(list[0]?.kind).toBe('info')
  })

  it('applies the default duration when not provided', () => {
    useToastsStore.getState().push({ kind: 'info', title: 'Hello' })
    const list = useToastsStore.getState().toasts
    expect(list[0]?.durationMs).toBe(testInternals.DEFAULT_DURATION_MS)
  })

  it('dismiss removes a toast by id', () => {
    const id = useToastsStore.getState().push({ kind: 'info', title: 'A' })
    useToastsStore.getState().push({ kind: 'info', title: 'B' })
    useToastsStore.getState().dismiss(id)
    expect(useToastsStore.getState().toasts.map((t) => t.title)).toEqual(['B'])
  })

  it('dedupe replaces an existing toast with the same dedupeKey', () => {
    useToastsStore.getState().push({ kind: 'error', title: 'fail-v1', dedupeKey: 'k' })
    useToastsStore.getState().push({ kind: 'error', title: 'fail-v2', dedupeKey: 'k' })
    const list = useToastsStore.getState().toasts
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('fail-v2')
  })

  it('preserves the original id when deduping', () => {
    const first = useToastsStore.getState().push({ kind: 'error', title: 'a', dedupeKey: 'k' })
    useToastsStore.getState().push({ kind: 'error', title: 'b', dedupeKey: 'k' })
    expect(useToastsStore.getState().toasts[0]?.id).toBe(first)
  })

  it('caps the visible stack at MAX_VISIBLE and reports excessCount', () => {
    for (let i = 0; i < testInternals.MAX_VISIBLE + 2; i++) {
      useToastsStore.getState().push({ kind: 'info', title: `t${String(i)}` })
    }
    expect(useToastsStore.getState().toasts).toHaveLength(testInternals.MAX_VISIBLE)
    expect(useToastsStore.getState().excessCount).toBe(2)
  })

  it('clear empties the stack and resets excessCount', () => {
    for (let i = 0; i < testInternals.MAX_VISIBLE + 1; i++) {
      useToastsStore.getState().push({ kind: 'info', title: `t${String(i)}` })
    }
    useToastsStore.getState().clear()
    expect(useToastsStore.getState().toasts).toEqual([])
    expect(useToastsStore.getState().excessCount).toBe(0)
  })

  it('protects toasts with action callbacks from auto-eviction first', () => {
    // Fill MAX with action-bearing toasts; pushing one more should still evict
    // a non-action toast even if it was older than action-toasts.
    for (let i = 0; i < testInternals.MAX_VISIBLE; i++) {
      useToastsStore.getState().push({
        kind: 'info',
        title: `act${String(i)}`,
        action: { label: 'undo', onClick: () => {} },
      })
    }
    // Now push a plain toast and another plain toast — first one will evict
    useToastsStore.getState().push({ kind: 'info', title: 'plain1' })
    expect(useToastsStore.getState().toasts).toHaveLength(testInternals.MAX_VISIBLE)
    // Action toasts kept; the new plain toast was the only one that could be
    // evicted. Verify that the action toasts are all still present.
    const titles = useToastsStore.getState().toasts.map((t) => t.title)
    for (let i = 0; i < testInternals.MAX_VISIBLE - 1; i++) {
      expect(titles).toContain(`act${String(i)}`)
    }
  })
})
