/**
 * comms/types.ts — typed-post Zod schemas + service-level shared types.
 *
 * Per TRD-05 §7.2 (Typed Post Catalog), §6.1.* (procedure shapes), §10.3.2
 * (inbox stream envelope).
 *
 * No Zod schemas defined here that re-implement @orbital/types — we re-export
 * branded ids and reuse ActorSchema. Post-type payload validators are defined
 * here as the single source of truth for both `channel.post` (MCP tool) and
 * `channel.post.create` (tRPC).
 */
import { z } from 'zod';
import { ActorSchema, type ChannelId, type CapabilityBundle, type Actor } from '@orbital/types';
import { CHANNEL_KIND, CHANNEL_POST_TYPE, MENTION_TARGET_TYPE, CROSS_REF_TYPE, CROSS_POST_ARTIFACT_TYPE, REACTION_TYPE, type ChannelKind, type ChannelPostType } from '@orbital/db';
import { BLOCKER_URGENCY, CEREMONY_TYPE, CEREMONY_PARTICIPANT_ROLE, CEREMONY_VOTE, CEREMONY_VOTE_RULE, CEREMONY_OUTPUT_KIND, DISAGREEMENT_DOMAIN, type BlockerUrgency, type CeremonyType } from '@orbital/db';
export { CHANNEL_KIND, CHANNEL_POST_TYPE, MENTION_TARGET_TYPE, CROSS_REF_TYPE, CROSS_POST_ARTIFACT_TYPE, REACTION_TYPE, BLOCKER_URGENCY, CEREMONY_TYPE, CEREMONY_PARTICIPANT_ROLE, CEREMONY_VOTE, CEREMONY_VOTE_RULE, CEREMONY_OUTPUT_KIND, DISAGREEMENT_DOMAIN, };
export type { ChannelKind, ChannelPostType, BlockerUrgency, CeremonyType, };
export declare const MentionRefSchema: z.ZodObject<{
    target_type: z.ZodEnum<["persona_role", "user", "persona_session"]>;
    target_ref: z.ZodString;
}, "strip", z.ZodTypeAny, {
    target_type: "user" | "persona_role" | "persona_session";
    target_ref: string;
}, {
    target_type: "user" | "persona_role" | "persona_session";
    target_ref: string;
}>;
export type MentionRef = z.infer<typeof MentionRefSchema>;
export declare const CrossReferenceRefSchema: z.ZodObject<{
    ref_type: z.ZodEnum<["ticket", "channel", "adr", "sprint", "epic", "commit", "ceremony", "defect"]>;
    ref_id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    ref_type: "sprint" | "ticket" | "channel" | "ceremony" | "defect" | "adr" | "epic" | "commit";
    ref_id: string;
}, {
    ref_type: "sprint" | "ticket" | "channel" | "ceremony" | "defect" | "adr" | "epic" | "commit";
    ref_id: string;
}>;
export type CrossReferenceRef = z.infer<typeof CrossReferenceRefSchema>;
/** Status update — workers narrate progress. */
export declare const StatusUpdatePayloadV1: z.ZodObject<{
    body: z.ZodString;
    ticket_id: z.ZodOptional<z.ZodString>;
    progress_pct: z.ZodOptional<z.ZodNumber>;
    next_step: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    ticket_id?: string | undefined;
    progress_pct?: number | undefined;
    next_step?: string | undefined;
}, {
    body: string;
    ticket_id?: string | undefined;
    progress_pct?: number | undefined;
    next_step?: string | undefined;
}>;
export type StatusUpdatePayload = z.infer<typeof StatusUpdatePayloadV1>;
/** Decision — a structured, durable choice (often cross-posted). */
export declare const DecisionPayloadV1: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    alternatives_considered: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    affects: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: string;
        id: string;
    }, {
        type: string;
        id: string;
    }>, "many">>;
    expires_at: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    title: string;
    alternatives_considered: string[];
    affects: {
        type: string;
        id: string;
    }[];
    expires_at?: string | undefined;
}, {
    body: string;
    title: string;
    alternatives_considered?: string[] | undefined;
    affects?: {
        type: string;
        id: string;
    }[] | undefined;
    expires_at?: string | undefined;
}>;
export type DecisionPayload = z.infer<typeof DecisionPayloadV1>;
/** Blocker post — mirrors the structured row in `blockers`. */
export declare const BlockerPostPayloadV1: z.ZodObject<{
    blocker_id: z.ZodString;
    question: z.ZodString;
    context: z.ZodString;
    requested_resolver_role: z.ZodString;
    urgency: z.ZodEnum<["low", "normal", "high", "critical"]>;
}, "strip", z.ZodTypeAny, {
    blocker_id: string;
    question: string;
    context: string;
    requested_resolver_role: string;
    urgency: "low" | "high" | "critical" | "normal";
}, {
    blocker_id: string;
    question: string;
    context: string;
    requested_resolver_role: string;
    urgency: "low" | "high" | "critical" | "normal";
}>;
export type BlockerPostPayload = z.infer<typeof BlockerPostPayloadV1>;
/** Alert — security or operational alert. */
export declare const AlertPayloadV1: z.ZodObject<{
    severity: z.ZodEnum<["low", "medium", "high", "critical"]>;
    title: z.ZodString;
    body: z.ZodString;
    source: z.ZodEnum<["hook_engine", "audit_reconciler", "security_officer", "system"]>;
    recommended_action: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    title: string;
    severity: "low" | "medium" | "high" | "critical";
    source: "system" | "hook_engine" | "audit_reconciler" | "security_officer";
    recommended_action?: string | undefined;
}, {
    body: string;
    title: string;
    severity: "low" | "medium" | "high" | "critical";
    source: "system" | "hook_engine" | "audit_reconciler" | "security_officer";
    recommended_action?: string | undefined;
}>;
export type AlertPayload = z.infer<typeof AlertPayloadV1>;
/** System event — drift, retro outcome, sprint state. */
export declare const SystemEventPayloadV1: z.ZodObject<{
    event_kind: z.ZodString;
    body: z.ZodString;
    linked_event_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    event_kind: string;
    linked_event_id?: string | undefined;
}, {
    body: string;
    event_kind: string;
    linked_event_id?: string | undefined;
}>;
export type SystemEventPayload = z.infer<typeof SystemEventPayloadV1>;
/** Cross-post — references an originating post + artifact. */
export declare const CrossPostPayloadV1: z.ZodObject<{
    origin_channel_id: z.ZodString;
    origin_post_id: z.ZodString;
    origin_author_role: z.ZodString;
    badge_label: z.ZodString;
    artifact_ref: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<["adr", "sprint_commitment", "security_finding", "standup_digest", "retro_outcome", "ticket_decision"]>;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "adr" | "sprint_commitment" | "security_finding" | "standup_digest" | "retro_outcome" | "ticket_decision";
        id: string;
    }, {
        type: "adr" | "sprint_commitment" | "security_finding" | "standup_digest" | "retro_outcome" | "ticket_decision";
        id: string;
    }>>;
    summary: z.ZodString;
}, "strip", z.ZodTypeAny, {
    origin_channel_id: string;
    origin_post_id: string;
    origin_author_role: string;
    badge_label: string;
    summary: string;
    artifact_ref?: {
        type: "adr" | "sprint_commitment" | "security_finding" | "standup_digest" | "retro_outcome" | "ticket_decision";
        id: string;
    } | undefined;
}, {
    origin_channel_id: string;
    origin_post_id: string;
    origin_author_role: string;
    badge_label: string;
    summary: string;
    artifact_ref?: {
        type: "adr" | "sprint_commitment" | "security_finding" | "standup_digest" | "retro_outcome" | "ticket_decision";
        id: string;
    } | undefined;
}>;
export type CrossPostPayload = z.infer<typeof CrossPostPayloadV1>;
/** Capability event — auto-posted on grant/deny (FR-5.22). */
export declare const CapabilityEventPayloadV1: z.ZodObject<{
    capability_id: z.ZodString;
    outcome: z.ZodEnum<["granted", "denied", "revoked"]>;
    scope: z.ZodString;
    requested_action: z.ZodString;
    reason: z.ZodString;
    affected_actor: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    capability_id: string;
    reason: string;
    outcome: "granted" | "denied" | "revoked";
    scope: string;
    requested_action: string;
    affected_actor: Record<string, unknown>;
}, {
    capability_id: string;
    reason: string;
    outcome: "granted" | "denied" | "revoked";
    scope: string;
    requested_action: string;
    affected_actor: Record<string, unknown>;
}>;
export type CapabilityEventPayload = z.infer<typeof CapabilityEventPayloadV1>;
/** User guidance — the user posting as Business (FR-5.17). */
export declare const UserGuidancePayloadV1: z.ZodObject<{
    body: z.ZodString;
    intent: z.ZodDefault<z.ZodEnum<["inform", "correct_context", "request_action", "observation"]>>;
}, "strip", z.ZodTypeAny, {
    body: string;
    intent: "inform" | "correct_context" | "request_action" | "observation";
}, {
    body: string;
    intent?: "inform" | "correct_context" | "request_action" | "observation" | undefined;
}>;
export type UserGuidancePayload = z.infer<typeof UserGuidancePayloadV1>;
/** Ceremony agenda — chair's opening post. */
export declare const CeremonyAgendaPayloadV1: z.ZodObject<{
    body: z.ZodString;
    open_questions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    proposals: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    body: string;
    open_questions: string[];
    proposals: string[];
}, {
    body: string;
    open_questions?: string[] | undefined;
    proposals?: string[] | undefined;
}>;
export type CeremonyAgendaPayload = z.infer<typeof CeremonyAgendaPayloadV1>;
/** Ceremony statement — participant turn body. */
export declare const CeremonyStatementPayloadV1: z.ZodObject<{
    body: z.ZodString;
    references_turn: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    body: string;
    references_turn?: number | undefined;
}, {
    body: string;
    references_turn?: number | undefined;
}>;
export type CeremonyStatementPayload = z.infer<typeof CeremonyStatementPayloadV1>;
/** Ceremony vote — chair's call or participant cast. */
export declare const CeremonyVotePayloadV1: z.ZodObject<{
    call_or_cast: z.ZodEnum<["call", "cast"]>;
    vote: z.ZodOptional<z.ZodEnum<["approve", "reject", "abstain", "approve_with_modifications"]>>;
    vote_rule: z.ZodOptional<z.ZodEnum<["simple_majority", "unanimous", "chair_decides"]>>;
    body: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    call_or_cast: "call" | "cast";
    body?: string | undefined;
    vote?: "approve" | "reject" | "abstain" | "approve_with_modifications" | undefined;
    vote_rule?: "simple_majority" | "unanimous" | "chair_decides" | undefined;
}, {
    call_or_cast: "call" | "cast";
    body?: string | undefined;
    vote?: "approve" | "reject" | "abstain" | "approve_with_modifications" | undefined;
    vote_rule?: "simple_majority" | "unanimous" | "chair_decides" | undefined;
}>;
export type CeremonyVotePayload = z.infer<typeof CeremonyVotePayloadV1>;
/** Ceremony output link — pointer to ceremony_outputs. */
export declare const CeremonyOutputLinkPayloadV1: z.ZodObject<{
    output_id: z.ZodString;
    output_kind: z.ZodString;
    summary: z.ZodString;
    linked_adr_id: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    summary: string;
    output_id: string;
    output_kind: string;
    linked_adr_id: string | null;
}, {
    summary: string;
    output_id: string;
    output_kind: string;
    linked_adr_id: string | null;
}>;
export type CeremonyOutputLinkPayload = z.infer<typeof CeremonyOutputLinkPayloadV1>;
/** Reply — generic threaded reply. */
export declare const ReplyPayloadV1: z.ZodObject<{
    body: z.ZodString;
}, "strip", z.ZodTypeAny, {
    body: string;
}, {
    body: string;
}>;
export type ReplyPayload = z.infer<typeof ReplyPayloadV1>;
/** Escalation note — an agent posts this when it is blocked and needs senior help. */
export declare const EscalationNotePayloadV1: z.ZodObject<{
    body: z.ZodString;
    confidence: z.ZodOptional<z.ZodNumber>;
    blocker_type: z.ZodOptional<z.ZodEnum<["low_confidence", "retry_budget_exhausted", "capability_denied", "review_loop", "unknown"]>>;
    sprint_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    confidence?: number | undefined;
    blocker_type?: "unknown" | "low_confidence" | "retry_budget_exhausted" | "capability_denied" | "review_loop" | undefined;
    sprint_id?: string | undefined;
}, {
    body: string;
    confidence?: number | undefined;
    blocker_type?: "unknown" | "low_confidence" | "retry_budget_exhausted" | "capability_denied" | "review_loop" | undefined;
    sprint_id?: string | undefined;
}>;
export type EscalationNotePayload = z.infer<typeof EscalationNotePayloadV1>;
/** Hand-off note — an agent posts this when work needs to be done by a different persona. */
export declare const HandoffNotePayloadV1: z.ZodObject<{
    body: z.ZodString;
    target_persona: z.ZodString;
    handoff_reason: z.ZodString;
    suggested_title: z.ZodOptional<z.ZodString>;
    suggested_description: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    body: string;
    target_persona: string;
    handoff_reason: string;
    suggested_title?: string | undefined;
    suggested_description?: string | undefined;
}, {
    body: string;
    target_persona: string;
    handoff_reason: string;
    suggested_title?: string | undefined;
    suggested_description?: string | undefined;
}>;
export type HandoffNotePayload = z.infer<typeof HandoffNotePayloadV1>;
/** Peer question — an agent posts this to #orb-engineering asking for design guidance. */
export declare const PeerQuestionPayloadV1: z.ZodObject<{
    body: z.ZodString;
    context_refs: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
}, "strip", z.ZodTypeAny, {
    body: string;
    context_refs: string[];
}, {
    body: string;
    context_refs?: string[] | undefined;
}>;
export type PeerQuestionPayload = z.infer<typeof PeerQuestionPayloadV1>;
export declare const POST_TYPE_SCHEMAS: Record<ChannelPostType, z.ZodTypeAny>;
/**
 * Validate a payload against the registered schema for a given post_type.
 * Returns parsed payload on success; throws ZodError on failure.
 */
export declare function validatePostPayload(postType: ChannelPostType, payload: unknown): Record<string, unknown>;
/** Parameters for `ChannelsService.post`. Capability is checked outside this type. */
export interface CreatePostParams {
    postType: ChannelPostType;
    payload: Record<string, unknown>;
    /**
     * Author actor; if omitted the service derives from the capability bundle
     * (persona type for agents) or the caller's session (user type for tRPC).
     */
    author?: Actor;
    parentPostId?: string;
    mentions?: MentionRef[];
    crossReferences?: CrossReferenceRef[];
    ceremonyId?: string;
    ceremonyTurnNumber?: number;
    tokensConsumed?: number;
    capabilityId?: string;
    /** Required justification (Primitives §14). */
    justification: string;
    /** Optional trace id; generated if omitted. */
    traceId?: string;
    /**
     * Round 7-01 — tenant isolation. When set, written to channel_posts.tenant_id.
     * Defaults to sentinel '00000000-0000-0000-0000-000000000000' when absent.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId?: string;
}
/** Result of `ChannelsService.post`. */
export interface CreatePostResult {
    postId: string;
    eventId: string;
    channelId: ChannelId;
    postType: ChannelPostType;
    resolvedMentions: Array<{
        mentionId: string;
        targetType: string;
        targetRef: string;
        priority: number;
    }>;
    resolvedCrossReferences: Array<{
        crossRefId: string;
        refType: string;
        refId: string;
    }>;
}
/** Inbox message — what subscribers see. */
export interface InboxMessage {
    cursor: string;
    postId: string;
    channelId: string;
    channelName: string;
    postType: ChannelPostType;
    payload: Record<string, unknown>;
    parentPostId: string | null;
    author: Record<string, unknown>;
    mentions: Array<{
        targetType: string;
        targetRef: string;
        priority: number;
    }>;
    crossReferences: Array<{
        refType: string;
        refId: string;
    }>;
    isPriority: boolean;
    occurredAt: string;
}
/**
 * Inbox stream message — discriminated union the MCP `inbox.subscribe` tool emits.
 * Per TRD-05 §10.3.2.
 */
export type InboxStreamMessage = {
    kind: 'stream_ready';
    cursor: string;
    resolved_channels: string[];
    server_time: string;
} | ({
    kind: 'inbox_post';
} & InboxMessage) | {
    kind: 'buffer_truncated';
    dropped_count: number;
    last_delivered_cursor: string;
    advice: 'call inbox.read_since to backfill';
} | {
    kind: 'heartbeat';
    server_time: string;
} | {
    kind: 'stream_error';
    code: string;
    message: string;
    advice: 'reconnect_with_cursor' | 'fall_back_to_poll' | 'fatal';
};
/** Regex from TRD-05 §7.3 — ticket / channel / ADR references. */
export declare const CROSS_REF_REGEX: RegExp;
export interface ParsedCrossReference {
    refType: 'ticket' | 'channel' | 'adr';
    refId: string;
    startOffset: number;
    endOffset: number;
}
/**
 * Parse cross-references from a body string. Does not resolve against
 * registries — that's the caller's responsibility. Returns offsets so the
 * renderer can rehydrate links.
 */
export declare function parseCrossReferences(body: string): ParsedCrossReference[];
export type { CapabilityBundle, Actor, ChannelId };
export { ActorSchema };
//# sourceMappingURL=types.d.ts.map