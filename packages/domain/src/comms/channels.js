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
import { uuidv7 } from 'uuidv7';
import { eq, and, sql as dSQL } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { channels, channelPosts, channelSubscriptions, mentions, crossReferences, crossPosts, pinnedPosts, reactions, presenceIndicators, channelPostTypes, } from '@orbital/db';
import { logger } from '../logger.js';
import { parseCrossReferences, validatePostPayload, POST_TYPE_SCHEMAS, CROSS_REF_TYPE, CROSS_POST_ARTIFACT_TYPE, } from './types.js';
// ---------------------------------------------------------------------------
// System actor (for service-emitted events)
// ---------------------------------------------------------------------------
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
function computeMentionPriority(ref, ctx) {
    // User → role: priority 1 (FR-5.19)
    if (ctx.authorActor.type === 'user' && ref.target_type === 'persona_role')
        return 1;
    // Critical alert (regardless of mention): priority 2
    if (ctx.postType === 'alert') {
        const severity = ctx.payload.severity;
        if (severity === 'critical')
            return 2;
    }
    // Budget warning system event: priority 3
    if (ctx.postType === 'system_event') {
        const eventKind = ctx.payload.event_kind;
        if (typeof eventKind === 'string' && eventKind.includes('budget_warning'))
            return 3;
    }
    // Default mention: priority 5
    return 5;
}
// ---------------------------------------------------------------------------
// Channel name policy (TRD-05 §10.1, §7.1)
// ---------------------------------------------------------------------------
const CHANNEL_NAME_REGEX = /^[#a-z0-9_-]+$/;
/** Compute the canonical name for a (kind, refId) pair. */
export function canonicalChannelName(kind, refId) {
    switch (kind) {
        case 'ticket_durable':
            return `#orb-${slug(refId)}`;
        case 'ticket_scratch':
            return `#scratch-orb-${slug(refId)}`;
        case 'epic':
            return `#epic-${slug(refId)}`;
        case 'sprint':
            return `#sprint-${slug(refId)}`;
        case 'topic':
            return refId.startsWith('#') ? refId : `#${slug(refId)}`;
        case 'ceremony':
            // Ceremony channels use the ceremony id directly (no '#' prefix per TRD-05 §7.1).
            return refId;
    }
}
function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}
// ---------------------------------------------------------------------------
// Default ChannelsService implementation
// ---------------------------------------------------------------------------
export class DefaultChannelsService {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    // -------------------------------------------------------------------------
    // ensureChannel
    // -------------------------------------------------------------------------
    async ensureChannel(kind, refId, options = {}) {
        const name = canonicalChannelName(kind, refId);
        if (kind !== 'ceremony' && !CHANNEL_NAME_REGEX.test(name)) {
            throw new OrbitalError('VALIDATION_CHANNEL_NAME_INVALID', `channel name '${name}' fails ^[#a-z0-9_-]+$`);
        }
        // Try to look up first.
        const existing = await this.db
            .select()
            .from(channels)
            .where(eq(channels.name, name))
            .limit(1);
        if (existing[0]) {
            return {
                channelId: existing[0].channelId,
                name: existing[0].name,
                created: false,
            };
        }
        // Insert new row.
        const channelId = uuidv7();
        const scopeRef = {};
        switch (kind) {
            case 'ticket_durable':
            case 'ticket_scratch':
                scopeRef['ticket_id'] = refId;
                break;
            case 'epic':
                scopeRef['epic_id'] = refId;
                break;
            case 'sprint':
                scopeRef['sprint_id'] = refId;
                break;
            case 'topic':
                scopeRef['topic'] = refId;
                break;
            case 'ceremony':
                scopeRef['ceremony_id'] = refId;
                break;
        }
        const createdBy = options.createdBy ?? SYSTEM_ACTOR;
        try {
            await this.db.insert(channels).values({
                channelId,
                name,
                kind,
                scopeRef,
                description: options.description ?? null,
                createdAt: new Date(),
                createdByActor: createdBy,
                archivedAt: null,
                schemaVersion: 1,
            });
        }
        catch (err) {
            // Idempotency: name unique conflict means another caller got there first.
            if (isUniqueViolation(err)) {
                const winner = await this.db
                    .select()
                    .from(channels)
                    .where(eq(channels.name, name))
                    .limit(1);
                if (winner[0]) {
                    return {
                        channelId: winner[0].channelId,
                        name: winner[0].name,
                        created: false,
                    };
                }
            }
            throw err;
        }
        // Emit ChannelCreated event.
        const ev = {
            aggregate_id: channelId,
            aggregate_type: 'channel',
            event_type: 'ChannelCreated',
            payload: {
                channel_id: channelId,
                name,
                kind,
                scope_ref: scopeRef,
                description: options.description ?? null,
            },
            actor: createdBy,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { channelId: channelId, name, created: true };
    }
    async bootstrapBaseline(actor = SYSTEM_ACTOR) {
        const baseline = [
            { name: '#security-alerts', description: 'Security alerts and incident routing' },
            { name: '#architecture-decisions', description: 'Architecture decisions and ADRs' },
            { name: '#escalations', description: 'User-facing escalations' },
            { name: '#capability-violations', description: 'Auto-posted on every CapabilityDenied' },
            { name: '#retro-feed', description: 'Retro proposals and outcomes' },
        ];
        for (const t of baseline) {
            await this.ensureChannel('topic', t.name, { description: t.description, createdBy: actor });
        }
    }
    // -------------------------------------------------------------------------
    // post
    // -------------------------------------------------------------------------
    async post(channelId, params, capability) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required (Primitives §14)');
        }
        const channel = await this.getById(channelId);
        if (!channel) {
            throw new OrbitalError('NOT_FOUND_CHANNEL', `channel ${channelId} not found`);
        }
        // Validate payload against post-type schema.
        let validatedPayload;
        try {
            validatedPayload = validatePostPayload(params.postType, params.payload);
        }
        catch (err) {
            throw new OrbitalError('VALIDATION_POST_PAYLOAD_INVALID', err instanceof Error ? err.message : 'invalid post payload');
        }
        // Cross-post specific guard: origin must not itself be a cross_post (prevents chains).
        if (params.postType === 'cross_post') {
            const originId = validatedPayload.origin_post_id;
            if (typeof originId === 'string') {
                const originRows = await this.db
                    .select()
                    .from(channelPosts)
                    .where(eq(channelPosts.postId, originId))
                    .limit(1);
                const origin = originRows[0];
                if (!origin) {
                    throw new OrbitalError('VALIDATION_INVALID_REQUEST', `origin_post_id ${originId} does not exist`);
                }
                if (origin.postType === 'cross_post') {
                    throw new OrbitalError('VALIDATION_INVALID_REQUEST', 'circular cross-post: origin must not itself be a cross_post');
                }
            }
        }
        // Derive author actor.
        const author = params.author ?? this.actorFromBundle(capability);
        // Parse inline cross-references from the body if present.
        const body = extractBody(params.postType, validatedPayload) ?? '';
        const parsedCrossRefs = parseCrossReferences(body);
        // Combine explicit + parsed cross references.
        // Explicit (caller-supplied) entries take precedence on (refType, refId).
        const explicit = params.crossReferences ?? [];
        const explicitKeys = new Set(explicit.map((r) => `${r.ref_type}:${r.ref_id}`));
        const allCrossRefs = [
            ...explicit.map((e) => ({
                refType: e.ref_type,
                refId: e.ref_id,
                startOffset: 0,
                endOffset: 0,
            })),
            ...parsedCrossRefs
                .filter((p) => !explicitKeys.has(`${p.refType}:${p.refId}`))
                .map((p) => ({
                refType: p.refType,
                refId: p.refId,
                startOffset: p.startOffset,
                endOffset: p.endOffset,
            })),
        ];
        // Validate cross-ref types against the catalog.
        for (const r of allCrossRefs) {
            if (!CROSS_REF_TYPE.includes(r.refType)) {
                throw new OrbitalError('VALIDATION_INVALID_REQUEST', `cross_reference ref_type '${r.refType}' is not in the catalog`);
            }
        }
        // Insert post row.
        const postId = uuidv7();
        const now = new Date();
        await this.db.insert(channelPosts).values({
            postId,
            channelId,
            parentPostId: params.parentPostId ?? null,
            postType: params.postType,
            authorActor: author,
            payload: validatedPayload,
            capabilityId: params.capabilityId ?? capability?.capability_id ?? null,
            ceremonyId: params.ceremonyId ?? null,
            ceremonyTurnNumber: params.ceremonyTurnNumber ?? null,
            tokensConsumed: params.tokensConsumed ?? null,
            createdAt: now,
            schemaVersion: 1,
            // Round 7-01: propagate tenantId when supplied (multi-tenant hub mode).
            // Falls back to DB column default (sentinel) for single-tenant installs.
            ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        });
        // Insert cross_references rows.
        const resolvedCrossReferences = [];
        if (allCrossRefs.length > 0) {
            for (const r of allCrossRefs) {
                const crossRefId = uuidv7();
                await this.db.insert(crossReferences).values({
                    crossRefId,
                    postId,
                    refType: r.refType,
                    refId: r.refId,
                    startOffset: r.startOffset,
                    endOffset: r.endOffset,
                });
                resolvedCrossReferences.push({ crossRefId, refType: r.refType, refId: r.refId });
            }
        }
        // Insert mentions rows + compute priority.
        const resolvedMentions = [];
        const mentionRefs = params.mentions ?? [];
        for (const m of mentionRefs) {
            const priority = computeMentionPriority(m, {
                postType: params.postType,
                authorActor: author,
                payload: validatedPayload,
            });
            const mentionId = uuidv7();
            await this.db.insert(mentions).values({
                mentionId,
                postId,
                targetType: m.target_type,
                targetRef: m.target_ref,
                deliveredAt: null,
                acknowledgedAt: null,
                priority,
                schemaVersion: 1,
            });
            resolvedMentions.push({
                mentionId,
                targetType: m.target_type,
                targetRef: m.target_ref,
                priority,
            });
        }
        const traceId = params.traceId ?? uuidv7();
        // Emit ChannelPostAdded.
        const postEvent = {
            aggregate_id: postId,
            aggregate_type: 'channel_post',
            event_type: 'ChannelPostAdded',
            payload: {
                post_id: postId,
                channel_id: channelId,
                parent_post_id: params.parentPostId ?? null,
                post_type: params.postType,
                payload: validatedPayload,
                ceremony_id: params.ceremonyId ?? null,
                ceremony_turn_number: params.ceremonyTurnNumber ?? null,
                mentions: resolvedMentions.map((m) => ({
                    target_type: m.targetType,
                    target_ref: m.targetRef,
                    priority: m.priority,
                })),
                cross_references: resolvedCrossReferences.map((r) => ({
                    ref_type: r.refType,
                    ref_id: r.refId,
                })),
            },
            actor: author,
            capability_id: params.capabilityId ?? capability?.capability_id,
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        const postEnvelope = await this.eventStore.append(postEvent);
        // Round 6 #9 follow-up — when the post is from an agent (persona actor)
        // with a UUID session_id (real worker), emit AgentChannelPosted aggregated
        // to the worker's session_id so the InspectionService (Round 6 #10) can
        // attribute the post to the worker for the AgentInspector UI.
        // Test fixtures sometimes use non-UUID sentinel session_ids (e.g. for
        // blocker/ceremony fixtures) — skip emission in that case.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (author.type === 'persona' && author.session_id && UUID_RE.test(author.session_id)) {
            const channelName = channel.name;
            const bodyExcerpt = JSON.stringify(validatedPayload).slice(0, 500);
            const agentEvent = {
                aggregate_id: author.session_id,
                aggregate_type: 'orchestration',
                event_type: 'AgentChannelPosted',
                payload: {
                    post_id: postId,
                    channel_id: channelId,
                    channel_name: channelName,
                    persona_id: author.persona_id,
                    session_id: author.session_id,
                    task_id: author.task_id ?? null,
                    sprint_id: resolvedCrossReferences.find((r) => r.refType === 'sprint')?.refId ?? null,
                    post_type: params.postType,
                    body_excerpt: bodyExcerpt,
                    cost_usd: 0,
                },
                actor: author,
                capability_id: params.capabilityId ?? capability?.capability_id,
                parent_event_id: postEnvelope.event_id,
                trace_id: traceId,
                occurred_at: now.toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(agentEvent);
        }
        // Emit MentionDelivered events (per mention) and stamp delivered_at.
        if (resolvedMentions.length > 0) {
            for (const m of resolvedMentions) {
                await this.db
                    .update(mentions)
                    .set({ deliveredAt: new Date() })
                    .where(eq(mentions.mentionId, m.mentionId));
                const ev = {
                    aggregate_id: postId,
                    aggregate_type: 'channel_post',
                    event_type: 'MentionDelivered',
                    payload: {
                        mention_id: m.mentionId,
                        post_id: postId,
                        target_type: m.targetType,
                        target_ref: m.targetRef,
                        delivery_path: 'inbox_stream',
                        priority: m.priority,
                    },
                    actor: author,
                    capability_id: params.capabilityId ?? capability?.capability_id,
                    parent_event_id: postEnvelope.event_id,
                    trace_id: traceId,
                    occurred_at: new Date().toISOString(),
                    schema_version: 1,
                };
                await this.eventStore.append(ev);
            }
        }
        return {
            postId,
            eventId: postEnvelope.event_id,
            channelId,
            postType: params.postType,
            resolvedMentions,
            resolvedCrossReferences,
        };
    }
    // -------------------------------------------------------------------------
    // subscribe / unsubscribe
    // -------------------------------------------------------------------------
    async subscribe(subscriberActor, channelIds, options = {}) {
        const out = [];
        const actorJson = JSON.stringify(subscriberActor);
        for (const cid of channelIds) {
            // Re-use an existing active subscription if one exists.
            const existing = await this.db
                .select()
                .from(channelSubscriptions)
                .where(and(eq(channelSubscriptions.channelId, cid), dSQL `subscriber_actor::text = ${actorJson}::text`, dSQL `unsubscribed_at IS NULL`))
                .limit(1);
            if (existing[0]) {
                out.push({ channelId: cid, subscriptionId: existing[0].subscriptionId });
                continue;
            }
            const subscriptionId = uuidv7();
            await this.db.insert(channelSubscriptions).values({
                subscriptionId,
                channelId: cid,
                subscriberActor: subscriberActor,
                taskId: options.taskId ?? null,
                source: options.source ?? 'explicit',
                capabilityId: options.capability?.capability_id ?? null,
                subscribedAt: new Date(),
                unsubscribedAt: null,
                schemaVersion: 1,
                // Round 7-01: propagate tenantId when supplied.
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
            });
            const ev = {
                aggregate_id: cid,
                aggregate_type: 'channel',
                event_type: 'ChannelSubscribed',
                payload: {
                    subscription_id: subscriptionId,
                    channel_id: cid,
                    task_id: options.taskId ?? null,
                    source: options.source ?? 'explicit',
                },
                actor: subscriberActor,
                capability_id: options.capability?.capability_id,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
            out.push({ channelId: cid, subscriptionId });
        }
        return out;
    }
    async unsubscribe(subscriberActor, channelId, reason, _options = {}) {
        // Soft-delete: stamp unsubscribed_at on the active subscription.
        const actorJson = JSON.stringify(subscriberActor);
        const updated = await this.db
            .update(channelSubscriptions)
            .set({ unsubscribedAt: new Date() })
            .where(and(eq(channelSubscriptions.channelId, channelId), dSQL `subscriber_actor::text = ${actorJson}::text`, dSQL `unsubscribed_at IS NULL`))
            .returning({ subscriptionId: channelSubscriptions.subscriptionId });
        if (updated.length === 0)
            return;
        for (const u of updated) {
            const ev = {
                aggregate_id: channelId,
                aggregate_type: 'channel',
                event_type: 'ChannelUnsubscribed',
                payload: {
                    subscription_id: u.subscriptionId,
                    channel_id: channelId,
                    reason,
                },
                actor: subscriberActor,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
    }
    // -------------------------------------------------------------------------
    // crossPost
    // -------------------------------------------------------------------------
    async crossPost(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        if (params.targetChannelNames.length === 0 || params.targetChannelNames.length > 10) {
            throw new OrbitalError('VALIDATION_INVALID_REQUEST', 'target_channels must be 1..10');
        }
        // Resolve origin post.
        const origins = await this.db
            .select()
            .from(channelPosts)
            .where(eq(channelPosts.postId, params.originatingPostId))
            .limit(1);
        const origin = origins[0];
        if (!origin) {
            throw new OrbitalError('NOT_FOUND_POST', `originating_post_id ${params.originatingPostId} not found`);
        }
        if (origin.postType === 'cross_post') {
            throw new OrbitalError('VALIDATION_INVALID_REQUEST', 'circular cross-post: origin must not itself be a cross_post');
        }
        // Validate artifact_ref type if provided.
        if (params.artifactRef) {
            if (!CROSS_POST_ARTIFACT_TYPE.includes(params.artifactRef.type)) {
                throw new OrbitalError('VALIDATION_INVALID_REQUEST', `artifact_ref.type '${params.artifactRef.type}' is not allowed`);
            }
        }
        const originAuthorRole = typeof origin.authorActor?.persona_id === 'string'
            ? (origin.authorActor.persona_id)
            : (origin.authorActor.type ?? 'unknown');
        const crossPostIds = [];
        const derivedPostIds = [];
        for (const targetName of params.targetChannelNames) {
            const targetRows = await this.db
                .select()
                .from(channels)
                .where(eq(channels.name, targetName))
                .limit(1);
            const target = targetRows[0];
            if (!target) {
                throw new OrbitalError('NOT_FOUND_CHANNEL', `target channel '${targetName}' not found`);
            }
            const payload = {
                origin_channel_id: origin.channelId,
                origin_post_id: origin.postId,
                origin_author_role: originAuthorRole,
                badge_label: params.badgeLabel,
                ...(params.artifactRef ? { artifact_ref: params.artifactRef } : {}),
                summary: params.summary,
            };
            const result = await this.post(target.channelId, {
                postType: 'cross_post',
                payload,
                author: params.author,
                capabilityId: params.capabilityId,
                justification: params.justification,
            });
            const crossPostId = uuidv7();
            await this.db.insert(crossPosts).values({
                crossPostId,
                originatingPostId: origin.postId,
                derivedPostId: result.postId,
                artifactRefType: params.artifactRef
                    ? params.artifactRef.type
                    : null,
                artifactRefId: params.artifactRef?.id ?? null,
                badgeLabel: params.badgeLabel,
                attribution: {
                    source_channel: origin.channelId,
                    source_post_id: origin.postId,
                    source_author: origin.authorActor,
                },
            });
            crossPostIds.push(crossPostId);
            derivedPostIds.push(result.postId);
        }
        return { crossPostIds, derivedPostIds };
    }
    // -------------------------------------------------------------------------
    // pin / unpin
    // -------------------------------------------------------------------------
    async pin(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        // Reject if an active pin exists.
        const existing = await this.db
            .select()
            .from(pinnedPosts)
            .where(and(eq(pinnedPosts.channelId, params.channelId), eq(pinnedPosts.postId, params.postId), dSQL `unpinned_at IS NULL`))
            .limit(1);
        if (existing[0]) {
            throw new OrbitalError('CONFLICT_PIN_ALREADY_ACTIVE', `post ${params.postId} already pinned in channel ${params.channelId}`);
        }
        const pinId = uuidv7();
        await this.db.insert(pinnedPosts).values({
            pinId,
            channelId: params.channelId,
            postId: params.postId,
            pinnedByActor: params.actor,
            capabilityId: params.capabilityId,
            pinnedAt: new Date(),
            unpinnedAt: null,
            reason: params.reason ?? null,
        });
        const ev = {
            aggregate_id: params.postId,
            aggregate_type: 'channel_post',
            event_type: 'ChannelPostPinned',
            payload: {
                pin_id: pinId,
                channel_id: params.channelId,
                post_id: params.postId,
                reason: params.reason ?? null,
            },
            actor: params.actor,
            capability_id: params.capabilityId,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { pinId };
    }
    async unpin(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        const updated = await this.db
            .update(pinnedPosts)
            .set({ unpinnedAt: new Date() })
            .where(and(eq(pinnedPosts.channelId, params.channelId), eq(pinnedPosts.postId, params.postId), dSQL `unpinned_at IS NULL`))
            .returning({ pinId: pinnedPosts.pinId });
        if (updated.length === 0)
            return;
        for (const row of updated) {
            const ev = {
                aggregate_id: params.postId,
                aggregate_type: 'channel_post',
                event_type: 'ChannelPostUnpinned',
                payload: {
                    pin_id: row.pinId,
                    channel_id: params.channelId,
                    post_id: params.postId,
                },
                actor: params.actor,
                capability_id: params.capabilityId,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
    }
    // -------------------------------------------------------------------------
    // react / unreact
    // -------------------------------------------------------------------------
    async react(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        const reactionId = uuidv7();
        await this.db.insert(reactions).values({
            reactionId,
            postId: params.postId,
            reactionType: params.reactionType,
            reactorActor: params.actor,
            capabilityId: params.capabilityId ?? null,
            createdAt: new Date(),
            removedAt: null,
        });
        const ev = {
            aggregate_id: params.postId,
            aggregate_type: 'channel_post',
            event_type: 'ReactionAdded',
            payload: {
                reaction_id: reactionId,
                post_id: params.postId,
                reaction_type: params.reactionType,
            },
            actor: params.actor,
            capability_id: params.capabilityId,
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { reactionId };
    }
    async unreact(params) {
        if (!params.justification?.trim()) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required');
        }
        const actorJson = JSON.stringify(params.actor);
        const updated = await this.db
            .update(reactions)
            .set({ removedAt: new Date() })
            .where(and(eq(reactions.postId, params.postId), eq(reactions.reactionType, params.reactionType), dSQL `reactor_actor::text = ${actorJson}::text`, dSQL `removed_at IS NULL`))
            .returning({ reactionId: reactions.reactionId });
        for (const row of updated) {
            const ev = {
                aggregate_id: params.postId,
                aggregate_type: 'channel_post',
                event_type: 'ReactionRemoved',
                payload: {
                    reaction_id: row.reactionId,
                    post_id: params.postId,
                },
                actor: params.actor,
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
    }
    // -------------------------------------------------------------------------
    // recordPresence (mutable; per FR-5.8)
    // -------------------------------------------------------------------------
    async recordPresence(params) {
        // Upsert keyed on (subscriber_actor, channel_id). Postgres does not have
        // a clean SQL way to upsert on a JSONB equality match; we do read-modify-write.
        const actorJson = JSON.stringify(params.actor);
        const existing = await this.db
            .select()
            .from(presenceIndicators)
            .where(and(eq(presenceIndicators.channelId, params.channelId), dSQL `subscriber_actor::text = ${actorJson}::text`))
            .limit(1);
        if (existing[0]) {
            await this.db
                .update(presenceIndicators)
                .set({ status: params.status, lastBeatAt: new Date() })
                .where(eq(presenceIndicators.presenceId, existing[0].presenceId));
        }
        else {
            await this.db.insert(presenceIndicators).values({
                presenceId: uuidv7(),
                subscriberActor: params.actor,
                channelId: params.channelId,
                status: params.status,
                lastBeatAt: new Date(),
            });
        }
    }
    // -------------------------------------------------------------------------
    // flushScratchChannel (FR-5.2)
    // -------------------------------------------------------------------------
    async flushScratchChannel(taskId, ticketId) {
        const scratchName = canonicalChannelName('ticket_scratch', ticketId);
        const durableName = canonicalChannelName('ticket_durable', ticketId);
        const [scratch] = await this.db
            .select()
            .from(channels)
            .where(eq(channels.name, scratchName))
            .limit(1);
        if (!scratch)
            return; // nothing to flush
        // Collect all status_update / reply posts in scratch order.
        const scratchPosts = await this.db
            .select()
            .from(channelPosts)
            .where(eq(channelPosts.channelId, scratch.channelId))
            .orderBy(channelPosts.createdAt);
        if (scratchPosts.length === 0) {
            // Just archive.
            await this.db
                .update(channels)
                .set({ archivedAt: new Date() })
                .where(eq(channels.channelId, scratch.channelId));
            return;
        }
        // Ensure durable exists.
        const durableEnsure = await this.ensureChannel('ticket_durable', ticketId);
        // Build a structured summary post into durable.
        const lines = scratchPosts.map((p) => {
            const body = typeof p.payload.body === 'string'
                ? (p.payload.body)
                : JSON.stringify(p.payload);
            return `- [${p.postType}] ${body}`;
        });
        const summary = `Scratch summary for task ${taskId} (${scratchPosts.length} posts):\n${lines.join('\n')}`.slice(0, 8000);
        await this.post(durableEnsure.channelId, {
            postType: 'system_event',
            payload: {
                event_kind: 'scratch_flushed',
                body: summary,
            },
            justification: `flushScratchChannel(taskId=${taskId})`,
            author: SYSTEM_ACTOR,
        });
        // Archive the scratch.
        await this.db
            .update(channels)
            .set({ archivedAt: new Date() })
            .where(eq(channels.channelId, scratch.channelId));
    }
    // -------------------------------------------------------------------------
    // getByName / getById
    // -------------------------------------------------------------------------
    async getByName(name) {
        const rows = await this.db.select().from(channels).where(eq(channels.name, name)).limit(1);
        const r = rows[0];
        if (!r)
            return null;
        return { channelId: r.channelId, name: r.name, kind: r.kind };
    }
    async getById(channelId) {
        const rows = await this.db
            .select()
            .from(channels)
            .where(eq(channels.channelId, channelId))
            .limit(1);
        const r = rows[0];
        if (!r)
            return null;
        return { channelId: r.channelId, name: r.name, kind: r.kind };
    }
    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------
    actorFromBundle(bundle) {
        if (!bundle)
            return SYSTEM_ACTOR;
        return {
            type: 'persona',
            persona_id: bundle.persona_id,
            session_id: bundle.session_id,
            ...(bundle.task_id !== undefined ? { task_id: bundle.task_id } : {}),
        };
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isUniqueViolation(err) {
    if (typeof err !== 'object' || err === null)
        return false;
    return err.code === '23505';
}
/** Extract a body string from a payload if present (used for cross-ref parsing). */
function extractBody(postType, payload) {
    if (typeof payload['body'] === 'string')
        return payload['body'];
    // Some post types use other fields as the textual body.
    if (postType === 'cross_post' && typeof payload['summary'] === 'string')
        return payload['summary'];
    if (postType === 'decision') {
        const title = typeof payload['title'] === 'string' ? payload['title'] : '';
        const body = typeof payload['body'] === 'string' ? payload['body'] : '';
        return `${title}\n${body}`;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Boot helper: seed channel_post_types lookup from POST_TYPE_SCHEMAS
// ---------------------------------------------------------------------------
/**
 * Idempotent seed of the channel_post_types lookup. Stores the JSON-encoded
 * Zod schema description (best-effort representation) so the row exists for
 * audit/export consumers; the runtime validator uses POST_TYPE_SCHEMAS in code.
 */
export async function seedChannelPostTypes(db) {
    for (const [postType, schema] of Object.entries(POST_TYPE_SCHEMAS)) {
        const row = {
            postType,
            payloadSchemaJson: { kind: 'zod', name: postType, source: schema.description ?? '' },
            schemaVersion: 1,
            description: `Typed post: ${postType}`,
        };
        try {
            await db.insert(channelPostTypes).values(row);
        }
        catch (err) {
            // Ignore duplicate inserts (idempotent boot).
            if (!isUniqueViolation(err)) {
                // Could be a Postgres "ON CONFLICT" if we wanted one; we just skip.
                logger.debug({ err, postType }, 'seedChannelPostTypes: insert failed (likely duplicate)');
            }
        }
    }
}
//# sourceMappingURL=channels.js.map