/**
 * Unit tests for the inbox FIFO buffer behavior.
 *
 * The InboxService.subscribe() returns an AsyncIterable backed by a per-stream
 * FIFO buffer (default cap 256). On overflow the oldest message is dropped
 * and a single buffer_truncated signal is enqueued at the tail.
 *
 * These tests exercise the buffer logic directly by feeding synthetic events
 * through a fake EventStore.subscribe.
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { DefaultInboxService } from '../../../src/comms/inbox.js'
import type { EventStore } from '../../../src/events/store.js'
import type { EventEnvelope } from '@orbital/types'
import type { ChannelId } from '@orbital/types'

// ---------------------------------------------------------------------------
// Fake EventStore that lets a test push events directly to subscribed handlers
// ---------------------------------------------------------------------------

class FakeEventStore implements EventStore {
  private handlers: Array<(event: EventEnvelope) => void> = []

  // The InboxService doesn't use these; we stub them.
  async append(): Promise<EventEnvelope> {
    throw new Error('not used in unit test')
  }
  async query(): Promise<{ items: EventEnvelope[]; next_cursor: null; has_more: false }> {
    return { items: [], next_cursor: null, has_more: false }
  }
  subscribe(_cursor: string | null, handler: (event: EventEnvelope) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler)
    }
  }

  push(event: EventEnvelope): void {
    for (const h of this.handlers) h(event)
  }
}

function makeChannelPostAdded(channelId: string): EventEnvelope {
  const postId = uuidv7()
  return {
    event_id: uuidv7(),
    aggregate_id: postId,
    aggregate_type: 'channel_post',
    event_type: 'ChannelPostAdded',
    payload: {
      post_id: postId,
      channel_id: channelId,
      post_type: 'status_update',
      payload: { body: 'hi' },
      mentions: [],
      cross_references: [],
    },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

function makeUnrelatedEvent(): EventEnvelope {
  return {
    event_id: uuidv7(),
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskCreated',
    payload: {},
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    ingested_at: new Date().toISOString(),
    schema_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboxService.subscribe — FIFO + filtering', () => {
  it('filters events by subscribed channel_id', async () => {
    const store = new FakeEventStore()
    const service = new DefaultInboxService(undefined as unknown as never, store)
    const channelA = uuidv7()
    const channelB = uuidv7()
    const sub = service.subscribe([channelA as ChannelId], null)

    // Publish: A, B, A (only A's pass through).
    const a1 = makeChannelPostAdded(channelA)
    const b1 = makeChannelPostAdded(channelB)
    const a2 = makeChannelPostAdded(channelA)
    store.push(a1)
    store.push(b1)
    store.push(a2)

    // Drain two messages.
    const it = sub.iterable[Symbol.asyncIterator]()
    const r1 = await it.next()
    const r2 = await it.next()
    sub.unsubscribe()

    expect(r1.value).toMatchObject({ kind: 'message' })
    expect(r2.value).toMatchObject({ kind: 'message' })
    if (r1.value?.kind === 'message') expect(r1.value.message.postId).toBe(String((a1.payload as Record<string, unknown>)['post_id']))
    if (r2.value?.kind === 'message') expect(r2.value.message.postId).toBe(String((a2.payload as Record<string, unknown>)['post_id']))
  })

  it('ignores non-ChannelPostAdded events', async () => {
    const store = new FakeEventStore()
    const service = new DefaultInboxService(undefined as unknown as never, store)
    const channelA = uuidv7()
    const sub = service.subscribe([channelA as ChannelId], null)

    store.push(makeUnrelatedEvent())
    store.push(makeChannelPostAdded(channelA))

    const it = sub.iterable[Symbol.asyncIterator]()
    const r1 = await it.next()
    sub.unsubscribe()

    expect(r1.value).toMatchObject({ kind: 'message' })
  })

  it('emits buffer_truncated on overflow and resets after delivery', async () => {
    const store = new FakeEventStore()
    const service = new DefaultInboxService(undefined as unknown as never, store)
    const channelA = uuidv7()
    const sub = service.subscribe([channelA as ChannelId], null, { bufferCap: 4 })

    // Push 6 messages; cap=4 → 2 should be dropped + 1 truncation signal.
    for (let i = 0; i < 6; i++) {
      store.push(makeChannelPostAdded(channelA))
    }

    type DrainItem =
      | { kind: 'message'; message: { cursor: string } }
      | { kind: 'buffer_truncated'; droppedCount: number; lastDeliveredCursor: string }
    const drained: DrainItem[] = []
    const it = sub.iterable[Symbol.asyncIterator]()
    // Drain all items currently in buffer.
    for (let i = 0; i < 5; i++) {
      const r = (await Promise.race([
        it.next(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 50)),
      ])) as IteratorResult<DrainItem>
      if (r.value === null) break
      drained.push(r.value)
    }
    sub.unsubscribe()

    const messages = drained.filter(
      (d): d is Extract<DrainItem, { kind: 'message' }> => d.kind === 'message',
    )
    const truncs = drained.filter(
      (d): d is Extract<DrainItem, { kind: 'buffer_truncated' }> => d.kind === 'buffer_truncated',
    )

    expect(messages.length).toBe(4)
    expect(truncs.length).toBe(1)
    expect(truncs[0]).toMatchObject({ droppedCount: 2 })

    // Round 2 BUG 2 contract: lastDeliveredCursor is the cursor of the LAST
    // message the consumer received BEFORE the truncation signal was yielded
    // — i.e. the cursor at the moment of delivery, not enqueue.
    //
    // Find the truncation's position in the drained sequence, then take the
    // cursor of the message immediately preceding it.
    const truncIdx = drained.findIndex((d) => d.kind === 'buffer_truncated')
    expect(truncIdx).toBeGreaterThanOrEqual(0)
    const expectedCursor = (() => {
      // Find the most recent message before the truncation in `drained`.
      for (let i = truncIdx - 1; i >= 0; i--) {
        const item = drained[i]
        if (item && item.kind === 'message') return item.message.cursor
      }
      return ''
    })()
    expect((truncs[0] as { lastDeliveredCursor: string }).lastDeliveredCursor).toBe(expectedCursor)
  })

  it('lastDeliveredCursor reflects the consumer cursor at delivery time, not enqueue time', async () => {
    // Precise contract test for the Round 2 BUG 2 fix. With the
    // current buffer ordering (survivors first, truncation appended),
    // when the consumer drains in order it will see surviving messages
    // BEFORE the truncation. We assert the truncation's cursor equals
    // the last surviving message that came out before it.
    const store = new FakeEventStore()
    const service = new DefaultInboxService(undefined as unknown as never, store)
    const channelA = uuidv7()
    const sub = service.subscribe([channelA as ChannelId], null, { bufferCap: 2 })

    // Push 4 messages; cap=2 → 2 should be dropped.
    for (let i = 0; i < 4; i++) {
      store.push(makeChannelPostAdded(channelA))
    }

    type DrainItem =
      | { kind: 'message'; message: { cursor: string } }
      | { kind: 'buffer_truncated'; droppedCount: number; lastDeliveredCursor: string }
    const drained: DrainItem[] = []
    const it = sub.iterable[Symbol.asyncIterator]()
    for (let i = 0; i < 4; i++) {
      const r = (await Promise.race([
        it.next(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 50)),
      ])) as IteratorResult<DrainItem>
      if (r.value === null) break
      drained.push(r.value)
    }
    sub.unsubscribe()

    // The consumer sees 2 messages (the survivors) and 1 truncation signal.
    const messages = drained.filter(
      (d): d is Extract<DrainItem, { kind: 'message' }> => d.kind === 'message',
    )
    const truncs = drained.filter(
      (d): d is Extract<DrainItem, { kind: 'buffer_truncated' }> => d.kind === 'buffer_truncated',
    )

    expect(messages.length).toBe(2)
    expect(truncs.length).toBe(1)

    // Find the truncation's index in drained; the cursor is the cursor of
    // the most recent message the consumer saw BEFORE the truncation was
    // delivered. If no message preceded the truncation, the cursor is '' —
    // which is the original subscribe cursor.
    const truncIdx = drained.findIndex((d) => d.kind === 'buffer_truncated')
    let expectedCursor = ''
    for (let i = truncIdx - 1; i >= 0; i--) {
      const item = drained[i]
      if (item && item.kind === 'message') {
        expectedCursor = item.message.cursor
        break
      }
    }
    expect(truncs[0]?.lastDeliveredCursor).toBe(expectedCursor)
  })

  it('delivers 5 messages in order within 100ms', async () => {
    const store = new FakeEventStore()
    const service = new DefaultInboxService(undefined as unknown as never, store)
    const channelA = uuidv7()
    const sub = service.subscribe([channelA as ChannelId], null)

    const events = Array.from({ length: 5 }, () => makeChannelPostAdded(channelA))
    const start = Date.now()
    for (const ev of events) store.push(ev)

    const drained: string[] = []
    const it = sub.iterable[Symbol.asyncIterator]()
    for (let i = 0; i < 5; i++) {
      const r = await it.next()
      if (r.value?.kind === 'message') drained.push(r.value.message.postId)
    }
    const elapsed = Date.now() - start
    sub.unsubscribe()

    const expectedOrder = events.map((e) => String((e.payload as Record<string, unknown>)['post_id']))
    expect(drained).toEqual(expectedOrder)
    expect(elapsed).toBeLessThan(100)
  })
})
