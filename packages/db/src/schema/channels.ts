/**
 * channels.ts — Drizzle schema for Phase 3A comms surface tables.
 *
 * Per TRD-05 §4.2.
 *
 * Owned tables (this file):
 *   - channels
 *   - channel_posts
 *   - channel_post_types        (lookup; runtime-seeded from §7.2)
 *   - channel_subscriptions
 *   - mentions
 *   - cross_references
 *   - cross_posts
 *   - pinned_posts
 *   - reactions
 *   - presence_indicators
 *
 * Notes:
 *   - All event-bearing rows are append-only at the application layer.
 *     Mutations on `channel_subscriptions`, `pinned_posts`, `reactions` use
 *     a `..._at` "tombstone" timestamp pattern (unsubscribed_at, unpinned_at,
 *     removed_at).
 *   - `presence_indicators` is the only mutable table — heartbeat updates a
 *     single row per (subscriber, channel).
 *   - `channel_posts.parent_post_id` is a self-FK added in 0007_comms.sql via
 *     ALTER TABLE (Drizzle does not generate the DDL; we don't need it for
 *     types).
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Enum constants (TS-side; SQL CHECK constraints declared in migration)
// ---------------------------------------------------------------------------

export const CHANNEL_KIND = [
  'ticket_durable',
  'ticket_scratch',
  'epic',
  'sprint',
  'topic',
  'ceremony',
] as const

export type ChannelKind = (typeof CHANNEL_KIND)[number]

export const CHANNEL_POST_TYPE = [
  'status_update',
  'decision',
  'blocker',
  'alert',
  'system_event',
  'cross_post',
  'capability_event',
  'user_guidance',
  'ceremony_agenda',
  'ceremony_statement',
  'ceremony_vote',
  'ceremony_output_link',
  'reply',
  // Round 6 #9 — Inter-Agent Channel Collaboration post types
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  'escalation_note',
  'handoff_note',
  'peer_question',
] as const

export type ChannelPostType = (typeof CHANNEL_POST_TYPE)[number]

export const SUBSCRIPTION_SOURCE = ['default', 'explicit', 'capability_grant'] as const
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCE)[number]

export const MENTION_TARGET_TYPE = ['persona_role', 'user', 'persona_session'] as const
export type MentionTargetType = (typeof MENTION_TARGET_TYPE)[number]

export const CROSS_REF_TYPE = [
  'ticket',
  'channel',
  'adr',
  'sprint',
  'epic',
  'commit',
  'ceremony',
  'defect',
] as const
export type CrossRefType = (typeof CROSS_REF_TYPE)[number]

export const CROSS_POST_ARTIFACT_TYPE = [
  'adr',
  'sprint_commitment',
  'security_finding',
  'standup_digest',
  'retro_outcome',
  'ticket_decision',
] as const
export type CrossPostArtifactType = (typeof CROSS_POST_ARTIFACT_TYPE)[number]

export const REACTION_TYPE = ['ack', 'thumbs_up', 'concern', 'eyes', 'fire'] as const
export type ReactionType = (typeof REACTION_TYPE)[number]

export const PRESENCE_STATUS = ['active', 'idle', 'offline'] as const
export type PresenceStatus = (typeof PRESENCE_STATUS)[number]

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export const channels = pgTable(
  'channels',
  {
    channelId: uuid('channel_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    name: text('name').notNull(),
    kind: text('kind', { enum: CHANNEL_KIND }).notNull(),
    /** Object: { ticket_id?, epic_id?, sprint_id?, ceremony_id?, topic? } */
    scopeRef: jsonb('scope_ref').$type<Record<string, string>>().notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** ActorSchema (Primitives §5). */
    createdByActor: jsonb('created_by_actor').$type<Record<string, unknown>>().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    nameUnique: uniqueIndex('channels_name_unique').on(t.name),
    kindIdx: index('channels_kind_idx').on(t.kind),
  }),
)

export type ChannelRow = typeof channels.$inferSelect
export type ChannelInsert = typeof channels.$inferInsert

// ---------------------------------------------------------------------------
// channel_posts
// ---------------------------------------------------------------------------

export const channelPosts = pgTable(
  'channel_posts',
  {
    postId: uuid('post_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.channelId),
    /** Self-ref FK declared via ALTER TABLE in 0007_comms.sql. */
    parentPostId: uuid('parent_post_id'),
    postType: text('post_type', { enum: CHANNEL_POST_TYPE }).notNull(),
    /** ActorSchema. */
    authorActor: jsonb('author_actor').$type<Record<string, unknown>>().notNull(),
    /** Type-specific payload validated against ChannelPostTypeRegistry. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    capabilityId: uuid('capability_id'),
    ceremonyId: uuid('ceremony_id'),
    ceremonyTurnNumber: integer('ceremony_turn_number'),
    tokensConsumed: integer('tokens_consumed'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /**
     * Migration 0019: soft tombstone for hygiene sweep.
     * Set to true on old test channel posts. Preserves the audit record but
     * allows UI queries to filter them out by default.
     */
    hiddenFromUi: boolean('hidden_from_ui').notNull().default(false),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    channelIdx: index('channel_posts_channel_idx').on(t.channelId, t.createdAt),
    parentIdx: index('channel_posts_parent_idx').on(t.parentPostId),
    ceremonyIdx: index('channel_posts_ceremony_idx').on(t.ceremonyId, t.ceremonyTurnNumber),
    typeIdx: index('channel_posts_type_idx').on(t.postType),
    hiddenIdx: index('channel_posts_hidden_idx').on(t.hiddenFromUi),
  }),
)

export type ChannelPostRow = typeof channelPosts.$inferSelect
export type ChannelPostInsert = typeof channelPosts.$inferInsert

// ---------------------------------------------------------------------------
// channel_post_types — lookup table seeded at boot
// ---------------------------------------------------------------------------

export const channelPostTypes = pgTable('channel_post_types', {
  postType: text('post_type').primaryKey(),
  payloadSchemaJson: jsonb('payload_schema_json').$type<Record<string, unknown>>().notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  description: text('description').notNull(),
})

export type ChannelPostTypeRow = typeof channelPostTypes.$inferSelect

// ---------------------------------------------------------------------------
// channel_subscriptions
// ---------------------------------------------------------------------------

export const channelSubscriptions = pgTable(
  'channel_subscriptions',
  {
    subscriptionId: uuid('subscription_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.channelId),
    subscriberActor: jsonb('subscriber_actor').$type<Record<string, unknown>>().notNull(),
    /** Null for user subscriptions; persona subs are task-scoped. */
    taskId: uuid('task_id'),
    source: text('source', { enum: SUBSCRIPTION_SOURCE }).notNull(),
    capabilityId: uuid('capability_id'),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true, mode: 'date' }),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    /** Active-subscription index: only rows where unsubscribed_at IS NULL. */
    channelActiveIdx: index('channel_subs_channel_idx')
      .on(t.channelId)
      .where(sql`unsubscribed_at IS NULL`),
    taskActiveIdx: index('channel_subs_task_idx')
      .on(t.taskId)
      .where(sql`unsubscribed_at IS NULL`),
  }),
)

export type ChannelSubscriptionRow = typeof channelSubscriptions.$inferSelect
export type ChannelSubscriptionInsert = typeof channelSubscriptions.$inferInsert

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

export const mentions = pgTable(
  'mentions',
  {
    mentionId: uuid('mention_id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => channelPosts.postId),
    targetType: text('target_type', { enum: MENTION_TARGET_TYPE }).notNull(),
    /** persona role slug, user_id, or session_id. */
    targetRef: text('target_ref').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
    /** Lower = higher priority. User → role: 1; alert: 2; default: 5. */
    priority: integer('priority').notNull().default(10),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    targetIdx: index('mentions_target_idx').on(t.targetType, t.targetRef, t.deliveredAt),
    postIdx: index('mentions_post_idx').on(t.postId),
  }),
)

export type MentionRow = typeof mentions.$inferSelect
export type MentionInsert = typeof mentions.$inferInsert

// ---------------------------------------------------------------------------
// cross_references
// ---------------------------------------------------------------------------

export const crossReferences = pgTable(
  'cross_references',
  {
    crossRefId: uuid('cross_ref_id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => channelPosts.postId),
    refType: text('ref_type', { enum: CROSS_REF_TYPE }).notNull(),
    refId: text('ref_id').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
  },
  (t) => ({
    refIdx: index('cross_refs_ref_idx').on(t.refType, t.refId),
  }),
)

export type CrossReferenceRow = typeof crossReferences.$inferSelect
export type CrossReferenceInsert = typeof crossReferences.$inferInsert

// ---------------------------------------------------------------------------
// cross_posts
// ---------------------------------------------------------------------------

export const crossPosts = pgTable(
  'cross_posts',
  {
    crossPostId: uuid('cross_post_id').primaryKey(),
    originatingPostId: uuid('originating_post_id')
      .notNull()
      .references(() => channelPosts.postId),
    derivedPostId: uuid('derived_post_id')
      .notNull()
      .references(() => channelPosts.postId),
    artifactRefType: text('artifact_ref_type', { enum: CROSS_POST_ARTIFACT_TYPE }),
    artifactRefId: text('artifact_ref_id'),
    badgeLabel: text('badge_label').notNull(),
    /** { source_channel, source_post_id, source_author }. */
    attribution: jsonb('attribution').$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    originIdx: index('cross_posts_origin_idx').on(t.originatingPostId),
  }),
)

export type CrossPostRow = typeof crossPosts.$inferSelect
export type CrossPostInsert = typeof crossPosts.$inferInsert

// ---------------------------------------------------------------------------
// pinned_posts
// ---------------------------------------------------------------------------

export const pinnedPosts = pgTable(
  'pinned_posts',
  {
    pinId: uuid('pin_id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.channelId),
    postId: uuid('post_id')
      .notNull()
      .references(() => channelPosts.postId),
    pinnedByActor: jsonb('pinned_by_actor').$type<Record<string, unknown>>().notNull(),
    capabilityId: uuid('capability_id').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    unpinnedAt: timestamp('unpinned_at', { withTimezone: true, mode: 'date' }),
    reason: text('reason'),
  },
  (t) => ({
    activePinUnique: uniqueIndex('pinned_posts_active_unique')
      .on(t.channelId, t.postId)
      .where(sql`unpinned_at IS NULL`),
  }),
)

export type PinnedPostRow = typeof pinnedPosts.$inferSelect
export type PinnedPostInsert = typeof pinnedPosts.$inferInsert

// ---------------------------------------------------------------------------
// reactions
// ---------------------------------------------------------------------------

export const reactions = pgTable(
  'reactions',
  {
    reactionId: uuid('reaction_id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => channelPosts.postId),
    reactionType: text('reaction_type', { enum: REACTION_TYPE }).notNull(),
    reactorActor: jsonb('reactor_actor').$type<Record<string, unknown>>().notNull(),
    capabilityId: uuid('capability_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    /** Active reaction unique on (post, type, actor); composite extracted in SQL via expression idx. */
    postReactionIdx: index('reactions_post_idx')
      .on(t.postId, t.reactionType)
      .where(sql`removed_at IS NULL`),
  }),
)

export type ReactionRow = typeof reactions.$inferSelect
export type ReactionInsert = typeof reactions.$inferInsert

// ---------------------------------------------------------------------------
// presence_indicators
// ---------------------------------------------------------------------------

export const presenceIndicators = pgTable(
  'presence_indicators',
  {
    presenceId: uuid('presence_id').primaryKey(),
    subscriberActor: jsonb('subscriber_actor').$type<Record<string, unknown>>().notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.channelId),
    status: text('status', { enum: PRESENCE_STATUS }).notNull(),
    lastBeatAt: timestamp('last_beat_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => ({
    channelPresenceIdx: index('presence_channel_idx').on(t.channelId, t.status, t.lastBeatAt),
  }),
)

export type PresenceIndicatorRow = typeof presenceIndicators.$inferSelect
export type PresenceIndicatorInsert = typeof presenceIndicators.$inferInsert
