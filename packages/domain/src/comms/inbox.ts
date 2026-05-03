/**
 * inbox.ts — InboxService.
 *
 * Per TRD-05 §6.2.1 (`inbox.subscribe`), §6.2.2 (`inbox.read_since`), §10.3
 * (push-based agent inbox protocol), §10.3.3 (backpressure buffer), §10.3.4
 * (reconnect), §10.3.5 (heartbeat), §10.3.6 (poll fallback).
 *
 * Streaming subscription:
 *   - subscribe(channelIds, cursor) → AsyncIterable<InboxMessage>
 *   - Internally: registers a handler with EventStore.subscribe(cursor, handler)
 *     that filters ChannelPostAdded events by channel_id ∈ subscribed set.
 *   - Per-stream FIFO buffer (default 256). On overflow, drops oldest, schedules
 *     a single buffer_truncated message; consumer must call readSince to backfill.
 *
 * Poll fallback:
 *   - readSince(channelIds, cursor) → PaginatedResponse<InboxMessage>
 *   - Reads channel_posts since the given cursor (event_id) ordered by event_id ASC.
 *
 * Cursor semantics (Round 2 fix — Option A):
 * ------------------------------------------
 * `InboxMessage.cursor` is the `event_id` of the corresponding ChannelPostAdded
 * event — NOT the channel_posts.post_id. This unifies the cursor namespace
 * between the live `EventStore.subscribe(cursor)` path and the poll
 * `readSince(cursor)` path: both paths interpret cursor as event_id and seek
 * monotonically against the events table. `postId` remains exposed as a
 * separate field on InboxMessage for downstream consumers.
 *
 * `buffer_truncated.lastDeliveredCursor` (Round 2 fix — BUG 2):
 * ------------------------------------------------------------
 * Tracks the cursor of the last message the consumer ACTUALLY CONSUMED via
 * `next()` — not the most recently enqueued message. If no message has yet
 * been delivered the value is the original subscribe cursor (or empty string
 * when the subscriber started from null).
 */

import { eq, and, gt, inArray, asc, sql as dSQL, type SQL } from 'drizzle-orm'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import type { EventEnvelope, PaginatedResponse, ChannelId } from '@orbital/types'
import {
  channels,
  channelPosts,
  type ChannelPostType,
} from '@orbital/db'
import { events } from '@orbital/db'
import { logger } from '../logger.js'
import type { InboxMessage, InboxStreamMessage } from './types.js'

// ---------------------------------------------------------------------------
// Buffer truncation signal (sentinel emitted by subscribe iterator)
// ---------------------------------------------------------------------------

export interface BufferTruncatedSignal {
  kind: 'buffer_truncated'
  droppedCount: number
  lastDeliveredCursor: string
  advice: 'call inbox.read_since to backfill'
}

export type SubscribeYield =
  | { kind: 'message'; message: InboxMessage }
  | BufferTruncatedSignal

// ---------------------------------------------------------------------------
// InboxService interface
// ---------------------------------------------------------------------------

export interface InboxService {
  /**
   * Subscribe to a stream of inbox messages.
   * Returns an AsyncIterable yielding messages or a single buffer_truncated
   * signal when the per-stream buffer overflows. The iterator never returns
   * end-of-stream; the consumer breaks out via for-await + break or by calling
   * the unsubscribe function.
   */
  subscribe(
    channelIds: ChannelId[],
    cursor: string | null,
    options?: SubscribeOptions,
  ): { iterable: AsyncIterable<SubscribeYield>; unsubscribe: () => void }

  /**
   * Streaming variant returning canonical `InboxStreamMessage` envelopes per
   * §10.3.2. Used by the MCP `inbox.subscribe` tool.
   */
  subscribeAsStream(
    channelIds: ChannelId[],
    cursor: string | null,
    options?: SubscribeOptions,
  ): { iterable: AsyncIterable<InboxStreamMessage>; unsubscribe: () => void }

  /** Synchronous backfill (for test harness / poll fallback). */
  readSince(
    channelIds: ChannelId[],
    cursor: string,
    options?: { limit?: number; recipient?: { type: string; ref: string } },
  ): Promise<PaginatedResponse<InboxMessage>>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SubscribeOptions {
  /** Per-stream buffer cap (default 256). Hard upper bound 1024. */
  bufferCap?: number
  /**
   * Recipient hint for is_priority (used for mention-priority delivery).
   * If supplied as `{ type: 'persona_role', ref: 'architect' }` we mark
   * messages whose mentions target this recipient as is_priority=true.
   */
  recipient?: { type: string; ref: string }
  /** Heartbeat cadence in ms (default 30000). */
  heartbeatMs?: number
}

const DEFAULT_BUFFER_CAP = 256
const MAX_BUFFER_CAP = 1024
const DEFAULT_HEARTBEAT_MS = 30_000

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultInboxService implements InboxService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  subscribe(
    channelIds: ChannelId[],
    cursor: string | null,
    options: SubscribeOptions = {},
  ): { iterable: AsyncIterable<SubscribeYield>; unsubscribe: () => void } {
    const bufferCap = Math.min(
      Math.max(options.bufferCap ?? DEFAULT_BUFFER_CAP, 1),
      MAX_BUFFER_CAP,
    )
    const channelSet = new Set<string>(channelIds.map((c) => String(c)))

    // Internal buffer. We yield from this in the async iterator.
    const buffer: SubscribeYield[] = []
    let droppedSinceLast = 0
    /**
     * Round 2 BUG 2 fix: track the cursor of the last message the CONSUMER has
     * actually seen (returned from `next()`), not the most recently enqueued
     * message. This is what `buffer_truncated.lastDeliveredCursor` carries so
     * workers calling `readSince(lastDeliveredCursor)` get the dropped-but-
     * not-yet-delivered messages.
     *
     * Initial value = cursor passed at subscribe (or empty string for a fresh
     * "from-now" subscriber).
     */
    let lastConsumedCursor: string = cursor ?? ''
    let truncationPending = false
    let waiter: ((value: void) => void) | null = null
    let stopped = false

    const wake = (): void => {
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    }

    const enqueue = (item: SubscribeYield): void => {
      if (stopped) return
      if (item.kind === 'message') {
        // Count the truncation signal as occupying the same buffer slot,
        // so the actual MESSAGE capacity is `bufferCap` regardless of whether
        // a truncation signal is pending.
        const messageCount = buffer.filter((b) => b.kind === 'message').length
        if (messageCount >= bufferCap) {
          // Drop the oldest message to make room for the new one.
          const oldestIdx = buffer.findIndex((b) => b.kind === 'message')
          if (oldestIdx >= 0) {
            buffer.splice(oldestIdx, 1)
            droppedSinceLast++
            // Locate or insert the single truncation signal. Its
            // `lastDeliveredCursor` is computed at delivery time (in next())
            // from the CONSUMER's current `lastConsumedCursor`, not the
            // enqueue-time value.
            const truncIdx = buffer.findIndex((b) => b.kind === 'buffer_truncated')
            if (truncIdx >= 0) {
              const tail = buffer[truncIdx]
              if (tail && tail.kind === 'buffer_truncated') {
                tail.droppedCount = droppedSinceLast
                // lastDeliveredCursor is finalized at delivery — leave the
                // current value as a placeholder; next() will overwrite.
              }
            } else if (!truncationPending) {
              truncationPending = true
              buffer.push({
                kind: 'buffer_truncated',
                droppedCount: droppedSinceLast,
                lastDeliveredCursor: '', // overwritten at delivery
                advice: 'call inbox.read_since to backfill',
              })
            }
          }
        }
        buffer.push(item)
      } else {
        // Non-message items always enqueued (truncation signal, etc.).
        buffer.push(item)
      }
      wake()
    }

    // Register handler with EventStore.
    const handler = (event: EventEnvelope): void => {
      if (event.event_type !== 'ChannelPostAdded') return
      const payload = event.payload as Record<string, unknown>
      const cId = payload['channel_id']
      if (typeof cId !== 'string' || !channelSet.has(cId)) return

      const message = envelopeToMessage(event, options.recipient)
      enqueue({ kind: 'message', message })
    }
    const unsubscribeFromStore = this.eventStore.subscribe(cursor, handler)

    const iterable: AsyncIterable<SubscribeYield> = {
      [Symbol.asyncIterator](): AsyncIterator<SubscribeYield> {
        return {
          async next(): Promise<IteratorResult<SubscribeYield>> {
            while (!stopped) {
              if (buffer.length > 0) {
                const item = buffer.shift() as SubscribeYield
                if (item.kind === 'message') {
                  // Update the consumer-visible cursor only when the consumer
                  // actually receives a message.
                  lastConsumedCursor = item.message.cursor
                  return { value: item, done: false }
                }
                if (item.kind === 'buffer_truncated') {
                  // Snapshot the consumer's cursor at delivery time. This is
                  // what readSince() needs to recover the dropped messages.
                  const signal: BufferTruncatedSignal = {
                    kind: 'buffer_truncated',
                    droppedCount: item.droppedCount,
                    lastDeliveredCursor: lastConsumedCursor,
                    advice: 'call inbox.read_since to backfill',
                  }
                  // Reset counters once delivered.
                  droppedSinceLast = 0
                  truncationPending = false
                  return { value: signal, done: false }
                }
                return { value: item, done: false }
              }
              await new Promise<void>((resolve) => {
                waiter = resolve
              })
            }
            return { value: undefined as unknown as SubscribeYield, done: true }
          },
          async return(): Promise<IteratorResult<SubscribeYield>> {
            stopped = true
            unsubscribeFromStore()
            wake()
            return { value: undefined as unknown as SubscribeYield, done: true }
          },
        }
      },
    }

    const unsubscribe = (): void => {
      stopped = true
      unsubscribeFromStore()
      wake()
    }

    return { iterable, unsubscribe }
  }

  // -------------------------------------------------------------------------
  // subscribeAsStream — wraps subscribe() into the canonical InboxStreamMessage
  // -------------------------------------------------------------------------

  subscribeAsStream(
    channelIds: ChannelId[],
    cursor: string | null,
    options: SubscribeOptions = {},
  ): { iterable: AsyncIterable<InboxStreamMessage>; unsubscribe: () => void } {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

    // Resolve channel names for the stream_ready envelope.
    const initialChannelIds = channelIds.map((c) => String(c))

    const inner = this.subscribe(channelIds, cursor, options)

    let stopped = false
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null

    // Use a queue to merge messages + heartbeats.
    const queue: InboxStreamMessage[] = []
    let queueWaiter: ((v: void) => void) | null = null
    const wake = (): void => {
      if (queueWaiter) {
        const w = queueWaiter
        queueWaiter = null
        w()
      }
    }
    const push = (m: InboxStreamMessage): void => {
      queue.push(m)
      wake()
    }

    // Initial stream_ready.
    push({
      kind: 'stream_ready',
      cursor: cursor ?? '',
      resolved_channels: initialChannelIds,
      server_time: new Date().toISOString(),
    })

    // Pump the underlying subscribe iterable.
    void (async () => {
      try {
        for await (const item of inner.iterable) {
          if (stopped) break
          if (item.kind === 'message') {
            push({ kind: 'inbox_post', ...item.message })
          } else {
            push({
              kind: 'buffer_truncated',
              dropped_count: item.droppedCount,
              last_delivered_cursor: item.lastDeliveredCursor,
              advice: 'call inbox.read_since to backfill',
            })
          }
        }
      } catch (err) {
        logger.error({ err }, 'InboxService.subscribeAsStream: pump error')
        push({
          kind: 'stream_error',
          code: 'INTEGRATION_MCP_STREAM_DROPPED',
          message: err instanceof Error ? err.message : 'stream pump error',
          advice: 'reconnect_with_cursor',
        })
      }
    })()

    // Heartbeats: emit when no message has been pushed in heartbeatMs.
    heartbeatTimer = setInterval(() => {
      if (stopped) return
      // Only emit a heartbeat if the queue is currently drained.
      if (queue.length === 0) {
        push({ kind: 'heartbeat', server_time: new Date().toISOString() })
      }
    }, heartbeatMs)
    heartbeatTimer.unref?.()

    const iterable: AsyncIterable<InboxStreamMessage> = {
      [Symbol.asyncIterator](): AsyncIterator<InboxStreamMessage> {
        return {
          async next(): Promise<IteratorResult<InboxStreamMessage>> {
            while (!stopped) {
              if (queue.length > 0) {
                return { value: queue.shift() as InboxStreamMessage, done: false }
              }
              await new Promise<void>((resolve) => {
                queueWaiter = resolve
              })
            }
            return { value: undefined as unknown as InboxStreamMessage, done: true }
          },
          async return(): Promise<IteratorResult<InboxStreamMessage>> {
            stopped = true
            inner.unsubscribe()
            if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
            wake()
            return { value: undefined as unknown as InboxStreamMessage, done: true }
          },
        }
      },
    }

    const unsubscribe = (): void => {
      stopped = true
      inner.unsubscribe()
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
      wake()
    }

    return { iterable, unsubscribe }
  }

  // -------------------------------------------------------------------------
  // readSince
  // -------------------------------------------------------------------------

  async readSince(
    channelIds: ChannelId[],
    cursor: string,
    options: { limit?: number; recipient?: { type: string; ref: string } } = {},
  ): Promise<PaginatedResponse<InboxMessage>> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)

    // Round 2 BUG 3 fix (Option A): cursor is now an `event_id`. We join
    // channel_posts to events on (events.aggregate_id = channel_posts.post_id
    // AND events.event_type = 'ChannelPostAdded') and filter by
    // events.event_id > cursor. Ordering is by events.event_id ASC so the
    // returned ordering matches the live subscribe path (event-id monotone).
    const conditions: SQL[] = [
      inArray(channelPosts.channelId, channelIds.map((c) => String(c))),
      eq(events.eventType, 'ChannelPostAdded'),
    ]
    if (cursor && cursor.length > 0) {
      conditions.push(gt(events.eventId, cursor))
    }

    const rows = await this.db
      .select({
        eventId: events.eventId,
        postId: channelPosts.postId,
        channelId: channelPosts.channelId,
        parentPostId: channelPosts.parentPostId,
        postType: channelPosts.postType,
        payload: channelPosts.payload,
        authorActor: channelPosts.authorActor,
        createdAt: channelPosts.createdAt,
        channelName: channels.name,
      })
      .from(channelPosts)
      .innerJoin(channels, eq(channelPosts.channelId, channels.channelId))
      .innerJoin(events, eq(events.aggregateId, channelPosts.postId))
      .where(and(...conditions))
      .orderBy(asc(events.eventId))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const items: InboxMessage[] = pageRows.map((r) => ({
      // cursor = event_id (Option A — single cursor namespace).
      cursor: r.eventId,
      postId: r.postId,
      channelId: r.channelId,
      channelName: r.channelName,
      postType: r.postType as ChannelPostType,
      payload: r.payload as Record<string, unknown>,
      parentPostId: r.parentPostId,
      author: r.authorActor as Record<string, unknown>,
      mentions: [],
      crossReferences: [],
      isPriority: false,
      occurredAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : new Date(r.createdAt as string).toISOString(),
    }))

    const last = items[items.length - 1]
    const nextCursor = hasMore && last ? last.cursor : null
    return { items, next_cursor: nextCursor, has_more: hasMore }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelopeToMessage(
  event: EventEnvelope,
  recipient?: { type: string; ref: string },
): InboxMessage {
  const payload = event.payload as Record<string, unknown>
  const channelId = String(payload['channel_id'] ?? '')
  const postId = String(payload['post_id'] ?? '')
  const postType = String(payload['post_type'] ?? '') as ChannelPostType
  const innerPayload = (payload['payload'] as Record<string, unknown>) ?? {}
  const parentPostId = (payload['parent_post_id'] as string | null | undefined) ?? null
  const mentionsArr = Array.isArray(payload['mentions']) ? payload['mentions'] : []
  const crossRefsArr = Array.isArray(payload['cross_references']) ? payload['cross_references'] : []
  const channelName = (payload['channel_name'] as string | undefined) ?? ''

  const mentions = (mentionsArr as Array<Record<string, unknown>>).map((m) => ({
    targetType: String(m['target_type'] ?? ''),
    targetRef: String(m['target_ref'] ?? ''),
    priority: Number(m['priority'] ?? 10),
  }))
  const crossReferences = (crossRefsArr as Array<Record<string, unknown>>).map((r) => ({
    refType: String(r['ref_type'] ?? ''),
    refId: String(r['ref_id'] ?? ''),
  }))

  const isPriority =
    recipient !== undefined &&
    mentions.some((m) => m.targetType === recipient.type && m.targetRef === recipient.ref)

  return {
    // Round 2 BUG 3 fix (Option A): cursor is the event_id, NOT the post_id.
    // This unifies the cursor namespace with EventStore.subscribe() and
    // readSince() so cursors are comparable across both paths.
    cursor: event.event_id,
    postId,
    channelId,
    channelName,
    postType,
    payload: innerPayload,
    parentPostId,
    author: event.actor as unknown as Record<string, unknown>,
    mentions,
    crossReferences,
    isPriority,
    occurredAt: event.occurred_at,
  }
}
