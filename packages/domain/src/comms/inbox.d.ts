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
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { PaginatedResponse, ChannelId } from '@orbital/types';
import type { InboxMessage, InboxStreamMessage } from './types.js';
export interface BufferTruncatedSignal {
    kind: 'buffer_truncated';
    droppedCount: number;
    lastDeliveredCursor: string;
    advice: 'call inbox.read_since to backfill';
}
export type SubscribeYield = {
    kind: 'message';
    message: InboxMessage;
} | BufferTruncatedSignal;
export interface InboxService {
    /**
     * Subscribe to a stream of inbox messages.
     * Returns an AsyncIterable yielding messages or a single buffer_truncated
     * signal when the per-stream buffer overflows. The iterator never returns
     * end-of-stream; the consumer breaks out via for-await + break or by calling
     * the unsubscribe function.
     */
    subscribe(channelIds: ChannelId[], cursor: string | null, options?: SubscribeOptions): {
        iterable: AsyncIterable<SubscribeYield>;
        unsubscribe: () => void;
    };
    /**
     * Streaming variant returning canonical `InboxStreamMessage` envelopes per
     * §10.3.2. Used by the MCP `inbox.subscribe` tool.
     */
    subscribeAsStream(channelIds: ChannelId[], cursor: string | null, options?: SubscribeOptions): {
        iterable: AsyncIterable<InboxStreamMessage>;
        unsubscribe: () => void;
    };
    /** Synchronous backfill (for test harness / poll fallback). */
    readSince(channelIds: ChannelId[], cursor: string, options?: {
        limit?: number;
        recipient?: {
            type: string;
            ref: string;
        };
    }): Promise<PaginatedResponse<InboxMessage>>;
}
export interface SubscribeOptions {
    /** Per-stream buffer cap (default 256). Hard upper bound 1024. */
    bufferCap?: number;
    /**
     * Recipient hint for is_priority (used for mention-priority delivery).
     * If supplied as `{ type: 'persona_role', ref: 'architect' }` we mark
     * messages whose mentions target this recipient as is_priority=true.
     */
    recipient?: {
        type: string;
        ref: string;
    };
    /** Heartbeat cadence in ms (default 30000). */
    heartbeatMs?: number;
}
export declare class DefaultInboxService implements InboxService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    subscribe(channelIds: ChannelId[], cursor: string | null, options?: SubscribeOptions): {
        iterable: AsyncIterable<SubscribeYield>;
        unsubscribe: () => void;
    };
    subscribeAsStream(channelIds: ChannelId[], cursor: string | null, options?: SubscribeOptions): {
        iterable: AsyncIterable<InboxStreamMessage>;
        unsubscribe: () => void;
    };
    readSince(channelIds: ChannelId[], cursor: string, options?: {
        limit?: number;
        recipient?: {
            type: string;
            ref: string;
        };
    }): Promise<PaginatedResponse<InboxMessage>>;
}
//# sourceMappingURL=inbox.d.ts.map