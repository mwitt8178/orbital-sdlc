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

import { z } from 'zod'
import {
  ActorSchema,
  type ChannelId,
  type CapabilityBundle,
  type Actor,
} from '@orbital/types'
import {
  CHANNEL_KIND,
  CHANNEL_POST_TYPE,
  MENTION_TARGET_TYPE,
  CROSS_REF_TYPE,
  CROSS_POST_ARTIFACT_TYPE,
  REACTION_TYPE,
  type ChannelKind,
  type ChannelPostType,
} from '../db/schema/channels.js'
import {
  BLOCKER_URGENCY,
  CEREMONY_TYPE,
  CEREMONY_PARTICIPANT_ROLE,
  CEREMONY_VOTE,
  CEREMONY_VOTE_RULE,
  CEREMONY_OUTPUT_KIND,
  DISAGREEMENT_DOMAIN,
  type BlockerUrgency,
  type CeremonyType,
} from '../db/schema/comms-workflow.js'

// ---------------------------------------------------------------------------
// Re-export common references
// ---------------------------------------------------------------------------

export {
  CHANNEL_KIND,
  CHANNEL_POST_TYPE,
  MENTION_TARGET_TYPE,
  CROSS_REF_TYPE,
  CROSS_POST_ARTIFACT_TYPE,
  REACTION_TYPE,
  BLOCKER_URGENCY,
  CEREMONY_TYPE,
  CEREMONY_PARTICIPANT_ROLE,
  CEREMONY_VOTE,
  CEREMONY_VOTE_RULE,
  CEREMONY_OUTPUT_KIND,
  DISAGREEMENT_DOMAIN,
}
export type {
  ChannelKind,
  ChannelPostType,
  BlockerUrgency,
  CeremonyType,
}

// ---------------------------------------------------------------------------
// Mention / cross-reference shared shapes (TRD-05 §4.2, §7.3)
// ---------------------------------------------------------------------------

export const MentionRefSchema = z.object({
  target_type: z.enum(MENTION_TARGET_TYPE),
  target_ref: z.string().min(1),
})
export type MentionRef = z.infer<typeof MentionRefSchema>

export const CrossReferenceRefSchema = z.object({
  ref_type: z.enum(CROSS_REF_TYPE),
  ref_id: z.string().min(1),
})
export type CrossReferenceRef = z.infer<typeof CrossReferenceRefSchema>

// ---------------------------------------------------------------------------
// Typed Post Catalog (TRD-05 §7.2)
// ---------------------------------------------------------------------------

/** Status update — workers narrate progress. */
export const StatusUpdatePayloadV1 = z.object({
  body: z.string().min(1).max(4000),
  ticket_id: z.string().optional(),
  progress_pct: z.number().int().min(0).max(100).optional(),
  next_step: z.string().optional(),
})
export type StatusUpdatePayload = z.infer<typeof StatusUpdatePayloadV1>

/** Decision — a structured, durable choice (often cross-posted). */
export const DecisionPayloadV1 = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  alternatives_considered: z.array(z.string()).default([]),
  affects: z.array(z.object({ type: z.string(), id: z.string() })).default([]),
  expires_at: z.string().datetime().optional(),
})
export type DecisionPayload = z.infer<typeof DecisionPayloadV1>

/** Blocker post — mirrors the structured row in `blockers`. */
export const BlockerPostPayloadV1 = z.object({
  blocker_id: z.string().uuid(),
  question: z.string().min(1),
  context: z.string().min(1),
  requested_resolver_role: z.string().min(1),
  urgency: z.enum(BLOCKER_URGENCY),
})
export type BlockerPostPayload = z.infer<typeof BlockerPostPayloadV1>

/** Alert — security or operational alert. */
export const AlertPayloadV1 = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.enum(['hook_engine', 'audit_reconciler', 'security_officer', 'system']),
  recommended_action: z.string().optional(),
})
export type AlertPayload = z.infer<typeof AlertPayloadV1>

/** System event — drift, retro outcome, sprint state. */
export const SystemEventPayloadV1 = z.object({
  event_kind: z.string().min(1),
  body: z.string().min(1),
  linked_event_id: z.string().optional(),
})
export type SystemEventPayload = z.infer<typeof SystemEventPayloadV1>

/** Cross-post — references an originating post + artifact. */
export const CrossPostPayloadV1 = z.object({
  origin_channel_id: z.string().uuid(),
  origin_post_id: z.string().uuid(),
  origin_author_role: z.string().min(1),
  badge_label: z.string().min(1).max(40),
  artifact_ref: z
    .object({
      type: z.enum(CROSS_POST_ARTIFACT_TYPE),
      id: z.string().min(1),
    })
    .optional(),
  summary: z.string().min(1).max(800),
})
export type CrossPostPayload = z.infer<typeof CrossPostPayloadV1>

/** Capability event — auto-posted on grant/deny (FR-5.22). */
export const CapabilityEventPayloadV1 = z.object({
  capability_id: z.string().uuid(),
  outcome: z.enum(['granted', 'denied', 'revoked']),
  scope: z.string().min(1),
  requested_action: z.string().min(1),
  reason: z.string().min(1),
  affected_actor: z.record(z.string(), z.unknown()),
})
export type CapabilityEventPayload = z.infer<typeof CapabilityEventPayloadV1>

/** User guidance — the user posting as Business (FR-5.17). */
export const UserGuidancePayloadV1 = z.object({
  body: z.string().min(1).max(8000),
  intent: z
    .enum(['inform', 'correct_context', 'request_action', 'observation'])
    .default('inform'),
})
export type UserGuidancePayload = z.infer<typeof UserGuidancePayloadV1>

/** Ceremony agenda — chair's opening post. */
export const CeremonyAgendaPayloadV1 = z.object({
  body: z.string().min(1).max(10000),
  open_questions: z.array(z.string()).default([]),
  proposals: z.array(z.string()).default([]),
})
export type CeremonyAgendaPayload = z.infer<typeof CeremonyAgendaPayloadV1>

/** Ceremony statement — participant turn body. */
export const CeremonyStatementPayloadV1 = z.object({
  body: z.string().min(1).max(6000),
  references_turn: z.number().int().optional(),
})
export type CeremonyStatementPayload = z.infer<typeof CeremonyStatementPayloadV1>

/** Ceremony vote — chair's call or participant cast. */
export const CeremonyVotePayloadV1 = z.object({
  call_or_cast: z.enum(['call', 'cast']),
  vote: z.enum(CEREMONY_VOTE).optional(),
  vote_rule: z.enum(CEREMONY_VOTE_RULE).optional(),
  body: z.string().optional(),
})
export type CeremonyVotePayload = z.infer<typeof CeremonyVotePayloadV1>

/** Ceremony output link — pointer to ceremony_outputs. */
export const CeremonyOutputLinkPayloadV1 = z.object({
  output_id: z.string().uuid(),
  output_kind: z.string().min(1),
  summary: z.string().min(1),
  linked_adr_id: z.string().uuid().nullable(),
})
export type CeremonyOutputLinkPayload = z.infer<typeof CeremonyOutputLinkPayloadV1>

/** Reply — generic threaded reply. */
export const ReplyPayloadV1 = z.object({
  body: z.string().min(1).max(6000),
})
export type ReplyPayload = z.infer<typeof ReplyPayloadV1>

// ---------------------------------------------------------------------------
// Round 6 #9 — Inter-Agent Channel Collaboration post payload schemas
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
// ---------------------------------------------------------------------------

/** Escalation note — an agent posts this when it is blocked and needs senior help. */
export const EscalationNotePayloadV1 = z.object({
  body: z.string().min(1).max(8000),
  confidence: z.number().int().min(0).max(100).optional(),
  blocker_type: z
    .enum(['low_confidence', 'retry_budget_exhausted', 'capability_denied', 'review_loop', 'unknown'])
    .optional(),
  sprint_id: z.string().optional(),
})
export type EscalationNotePayload = z.infer<typeof EscalationNotePayloadV1>

/** Hand-off note — an agent posts this when work needs to be done by a different persona. */
export const HandoffNotePayloadV1 = z.object({
  body: z.string().min(1).max(8000),
  target_persona: z.string().min(1),
  handoff_reason: z.string().min(1).max(2000),
  suggested_title: z.string().max(200).optional(),
  suggested_description: z.string().max(8000).optional(),
})
export type HandoffNotePayload = z.infer<typeof HandoffNotePayloadV1>

/** Peer question — an agent posts this to #orb-engineering asking for design guidance. */
export const PeerQuestionPayloadV1 = z.object({
  body: z.string().min(1).max(8000),
  context_refs: z.array(z.string()).max(10).optional().default([]),
})
export type PeerQuestionPayload = z.infer<typeof PeerQuestionPayloadV1>

// ---------------------------------------------------------------------------
// Post-type registry (lookup by post_type → schema)
// ---------------------------------------------------------------------------

export const POST_TYPE_SCHEMAS: Record<ChannelPostType, z.ZodTypeAny> = {
  status_update: StatusUpdatePayloadV1,
  decision: DecisionPayloadV1,
  blocker: BlockerPostPayloadV1,
  alert: AlertPayloadV1,
  system_event: SystemEventPayloadV1,
  cross_post: CrossPostPayloadV1,
  capability_event: CapabilityEventPayloadV1,
  user_guidance: UserGuidancePayloadV1,
  ceremony_agenda: CeremonyAgendaPayloadV1,
  ceremony_statement: CeremonyStatementPayloadV1,
  ceremony_vote: CeremonyVotePayloadV1,
  ceremony_output_link: CeremonyOutputLinkPayloadV1,
  reply: ReplyPayloadV1,
  // Round 6 #9 — Inter-Agent Channel Collaboration
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  escalation_note: EscalationNotePayloadV1,
  handoff_note: HandoffNotePayloadV1,
  peer_question: PeerQuestionPayloadV1,
}

/**
 * Validate a payload against the registered schema for a given post_type.
 * Returns parsed payload on success; throws ZodError on failure.
 */
export function validatePostPayload(
  postType: ChannelPostType,
  payload: unknown,
): Record<string, unknown> {
  const schema = POST_TYPE_SCHEMAS[postType]
  if (!schema) {
    throw new Error(`VALIDATION_POST_PAYLOAD_INVALID: unknown post_type ${postType}`)
  }
  return schema.parse(payload) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Service-level types
// ---------------------------------------------------------------------------

/** Parameters for `ChannelsService.post`. Capability is checked outside this type. */
export interface CreatePostParams {
  postType: ChannelPostType
  payload: Record<string, unknown>
  /**
   * Author actor; if omitted the service derives from the capability bundle
   * (persona type for agents) or the caller's session (user type for tRPC).
   */
  author?: Actor
  parentPostId?: string
  mentions?: MentionRef[]
  crossReferences?: CrossReferenceRef[]
  ceremonyId?: string
  ceremonyTurnNumber?: number
  tokensConsumed?: number
  capabilityId?: string
  /** Required justification (Primitives §14). */
  justification: string
  /** Optional trace id; generated if omitted. */
  traceId?: string
  /**
   * Round 7-01 — tenant isolation. When set, written to channel_posts.tenant_id.
   * Defaults to sentinel '00000000-0000-0000-0000-000000000000' when absent.
   * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
   */
  tenantId?: string
}

/** Result of `ChannelsService.post`. */
export interface CreatePostResult {
  postId: string
  eventId: string
  channelId: ChannelId
  postType: ChannelPostType
  resolvedMentions: Array<{ mentionId: string; targetType: string; targetRef: string; priority: number }>
  resolvedCrossReferences: Array<{ crossRefId: string; refType: string; refId: string }>
}

/** Inbox message — what subscribers see. */
export interface InboxMessage {
  cursor: string
  postId: string
  channelId: string
  channelName: string
  postType: ChannelPostType
  payload: Record<string, unknown>
  parentPostId: string | null
  author: Record<string, unknown>
  mentions: Array<{ targetType: string; targetRef: string; priority: number }>
  crossReferences: Array<{ refType: string; refId: string }>
  isPriority: boolean
  occurredAt: string
}

/**
 * Inbox stream message — discriminated union the MCP `inbox.subscribe` tool emits.
 * Per TRD-05 §10.3.2.
 */
export type InboxStreamMessage =
  | {
      kind: 'stream_ready'
      cursor: string
      resolved_channels: string[]
      server_time: string
    }
  | ({ kind: 'inbox_post' } & InboxMessage)
  | {
      kind: 'buffer_truncated'
      dropped_count: number
      last_delivered_cursor: string
      advice: 'call inbox.read_since to backfill'
    }
  | { kind: 'heartbeat'; server_time: string }
  | {
      kind: 'stream_error'
      code: string
      message: string
      advice: 'reconnect_with_cursor' | 'fall_back_to_poll' | 'fatal'
    }

// ---------------------------------------------------------------------------
// Cross-reference parser (TRD-05 §7.3)
// ---------------------------------------------------------------------------

/** Regex from TRD-05 §7.3 — ticket / channel / ADR references. */
export const CROSS_REF_REGEX = /(~[A-Z]+-\d+)|(#[a-z0-9_-]+)|(ADR-\d+)/g

export interface ParsedCrossReference {
  refType: 'ticket' | 'channel' | 'adr'
  refId: string
  startOffset: number
  endOffset: number
}

/**
 * Parse cross-references from a body string. Does not resolve against
 * registries — that's the caller's responsibility. Returns offsets so the
 * renderer can rehydrate links.
 */
export function parseCrossReferences(body: string): ParsedCrossReference[] {
  const refs: ParsedCrossReference[] = []
  let match: RegExpExecArray | null
  // Reset lastIndex to ensure consistent state across calls.
  CROSS_REF_REGEX.lastIndex = 0
  while ((match = CROSS_REF_REGEX.exec(body)) !== null) {
    const fullMatch = match[0]
    const startOffset = match.index
    const endOffset = startOffset + fullMatch.length
    if (match[1]) {
      // Ticket: ~ORB-237 → strip leading `~`
      refs.push({
        refType: 'ticket',
        refId: fullMatch.slice(1),
        startOffset,
        endOffset,
      })
    } else if (match[2]) {
      // Channel: #sprint-14
      refs.push({
        refType: 'channel',
        refId: fullMatch,
        startOffset,
        endOffset,
      })
    } else if (match[3]) {
      // ADR: ADR-014
      refs.push({
        refType: 'adr',
        refId: fullMatch,
        startOffset,
        endOffset,
      })
    }
  }
  return refs
}

// ---------------------------------------------------------------------------
// Capability shape — for service signatures
// ---------------------------------------------------------------------------

export type { CapabilityBundle, Actor, ChannelId }
export { ActorSchema }
