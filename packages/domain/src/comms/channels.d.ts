/**
 * channels.ts — ChannelsService.
 *
 * Per TRD-05 §6.1, §6.2, §10.1, §10.2, §10.4, §10.6, §10.10.
 *
 * Responsibilities:
 *   - ensureChannel(kind, refId) — idempotent channel creation; emits ChannelCreated.
 *   - post(channelId, params, capability) — validates payload, parses inline
 *     cross-refs, resolves @mentions, writes channel_posts row + event.
 *   - subscribe(actor, channelIds, capability) — task-scoped subscriptions per
 *     FR-5.6/5.7; emits ChannelSubscribed.
 *   - mention resolution — writes mentions rows with priority routing per
 *     FR-5.12/5.19/§10.4.
 *   - crossPost — copies a derived post to N target channels with attribution
 *     per FR-5.14.
 *   - pin/unpin, react/unreact.
 *   - presence heartbeat — writes presence_indicators rows.
 *   - flushScratchChannel(taskId) — at task close, summarize scratch into
 *     durable per FR-5.2.
 *
 * All events go through EventStore.append. No direct db.insert(events).
 */
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { CapabilityBundle, Actor, ChannelId } from '@orbital/types';
import { type ChannelKind, type ReactionType } from '@orbital/db';
import { type CreatePostParams, type CreatePostResult } from './types.js';
export interface ChannelsService {
    /** Ensure a channel for (kind, refId) exists. Idempotent. */
    ensureChannel(kind: ChannelKind, refId: string, options?: {
        description?: string;
        createdBy?: Actor;
    }): Promise<{
        channelId: ChannelId;
        name: string;
        created: boolean;
    }>;
    /** Idempotent boot-time topic seeding (TRD-05 §7.1, §10.1). */
    bootstrapBaseline(actor?: Actor): Promise<void>;
    /** Post to a channel (capability-checked by caller; we record capability_id). */
    post(channelId: ChannelId, params: CreatePostParams, capability?: CapabilityBundle): Promise<CreatePostResult>;
    /** Subscribe an actor to a list of channels (task-scoped if persona). */
    subscribe(subscriberActor: Actor, channelIds: ChannelId[], options?: {
        taskId?: string;
        capability?: CapabilityBundle;
        source?: 'default' | 'explicit' | 'capability_grant';
        justification?: string;
        /** Round 7-01 — tenant isolation. [Engineer-Sr · Sonnet · run-round7-01-extract-hub] */
        tenantId?: string;
    }): Promise<Array<{
        channelId: ChannelId;
        subscriptionId: string;
    }>>;
    /** Unsubscribe by channel id (per actor). */
    unsubscribe(subscriberActor: Actor, channelId: ChannelId, reason: 'task_close' | 'explicit' | 'capability_revoked', options?: {
        justification?: string;
    }): Promise<void>;
    /** Cross-post to N target channels (no duplication). */
    crossPost(params: {
        originatingPostId: string;
        targetChannelNames: string[];
        badgeLabel: string;
        artifactRef?: {
            type: string;
            id: string;
        };
        author: Actor;
        capabilityId?: string;
        summary: string;
        justification: string;
    }): Promise<{
        crossPostIds: string[];
        derivedPostIds: string[];
    }>;
    /** Pin a post in a channel. */
    pin(params: {
        channelId: ChannelId;
        postId: string;
        actor: Actor;
        capabilityId: string;
        reason?: string;
        justification: string;
    }): Promise<{
        pinId: string;
    }>;
    /** Unpin a post (idempotent). */
    unpin(params: {
        channelId: ChannelId;
        postId: string;
        actor: Actor;
        capabilityId: string;
        justification: string;
    }): Promise<void>;
    /** Add a reaction to a post. */
    react(params: {
        postId: string;
        reactionType: ReactionType;
        actor: Actor;
        capabilityId?: string;
        justification: string;
    }): Promise<{
        reactionId: string;
    }>;
    /** Remove a reaction (idempotent if missing). */
    unreact(params: {
        postId: string;
        reactionType: ReactionType;
        actor: Actor;
        justification: string;
    }): Promise<void>;
    /** Heartbeat-driven presence update; called by inbox stream + WS hub. */
    recordPresence(params: {
        actor: Actor;
        channelId: ChannelId;
        status: 'active' | 'idle' | 'offline';
    }): Promise<void>;
    /**
     * Flush a scratch channel at task close (FR-5.2): write a structured summary
     * to the durable channel and archive the scratch.
     */
    flushScratchChannel(taskId: string, ticketId: string): Promise<void>;
    /** Resolve a channel by name. */
    getByName(name: string): Promise<{
        channelId: ChannelId;
        name: string;
        kind: ChannelKind;
    } | null>;
    /** Resolve a channel id to row. */
    getById(channelId: ChannelId): Promise<{
        channelId: ChannelId;
        name: string;
        kind: ChannelKind;
    } | null>;
}
/** Compute the canonical name for a (kind, refId) pair. */
export declare function canonicalChannelName(kind: ChannelKind, refId: string): string;
export declare class DefaultChannelsService implements ChannelsService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    ensureChannel(kind: ChannelKind, refId: string, options?: {
        description?: string;
        createdBy?: Actor;
    }): Promise<{
        channelId: ChannelId;
        name: string;
        created: boolean;
    }>;
    bootstrapBaseline(actor?: Actor): Promise<void>;
    post(channelId: ChannelId, params: CreatePostParams, capability?: CapabilityBundle): Promise<CreatePostResult>;
    subscribe(subscriberActor: Actor, channelIds: ChannelId[], options?: {
        taskId?: string;
        capability?: CapabilityBundle;
        source?: 'default' | 'explicit' | 'capability_grant';
        justification?: string;
        tenantId?: string;
    }): Promise<Array<{
        channelId: ChannelId;
        subscriptionId: string;
    }>>;
    unsubscribe(subscriberActor: Actor, channelId: ChannelId, reason: 'task_close' | 'explicit' | 'capability_revoked', _options?: {
        justification?: string;
    }): Promise<void>;
    crossPost(params: {
        originatingPostId: string;
        targetChannelNames: string[];
        badgeLabel: string;
        artifactRef?: {
            type: string;
            id: string;
        };
        author: Actor;
        capabilityId?: string;
        summary: string;
        justification: string;
    }): Promise<{
        crossPostIds: string[];
        derivedPostIds: string[];
    }>;
    pin(params: {
        channelId: ChannelId;
        postId: string;
        actor: Actor;
        capabilityId: string;
        reason?: string;
        justification: string;
    }): Promise<{
        pinId: string;
    }>;
    unpin(params: {
        channelId: ChannelId;
        postId: string;
        actor: Actor;
        capabilityId: string;
        justification: string;
    }): Promise<void>;
    react(params: {
        postId: string;
        reactionType: ReactionType;
        actor: Actor;
        capabilityId?: string;
        justification: string;
    }): Promise<{
        reactionId: string;
    }>;
    unreact(params: {
        postId: string;
        reactionType: ReactionType;
        actor: Actor;
        justification: string;
    }): Promise<void>;
    recordPresence(params: {
        actor: Actor;
        channelId: ChannelId;
        status: 'active' | 'idle' | 'offline';
    }): Promise<void>;
    flushScratchChannel(taskId: string, ticketId: string): Promise<void>;
    getByName(name: string): Promise<{
        channelId: ChannelId;
        name: string;
        kind: ChannelKind;
    } | null>;
    getById(channelId: ChannelId): Promise<{
        channelId: ChannelId;
        name: string;
        kind: ChannelKind;
    } | null>;
    private actorFromBundle;
}
/**
 * Idempotent seed of the channel_post_types lookup. Stores the JSON-encoded
 * Zod schema description (best-effort representation) so the row exists for
 * audit/export consumers; the runtime validator uses POST_TYPE_SCHEMAS in code.
 */
export declare function seedChannelPostTypes(db: DB): Promise<void>;
//# sourceMappingURL=channels.d.ts.map