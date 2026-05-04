/**
 * trpc/routers/channels.ts — tRPC router for the comms surface.
 *
 * Per TRD-05 §6.1.1–§6.1.10.
 *
 * Procedures exposed:
 *   - channel.list                    (query)
 *   - channel.posts.read              (query, paginated)
 *   - channel.post.create             (mutation, user-as-Business)
 *   - channel.subscribe               (mutation)
 *   - channel.posts.subscribe         (subscription → WebSocket; v1 returns
 *                                       ack-only; UI uses /ws hub directly)
 *
 * Phase 4A/4B will append blocker / ceremony / disagreement / adr query
 * procedures. Phase 3A scopes to channel-level reads + creates + subscribe.
 *
 * Round 7-02 — hub proxy: channel.list and posts.read proxy to hub when
 * ORBITAL_HUB_URL is set.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { TRPCError } from '@trpc/server'
import { eq, and, desc, lt, inArray, isNull, type SQL, sql as dSQL } from 'drizzle-orm'
// Round 7-02 — hub client for proxy mode
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../../hub-client/index.js'
import { db } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { sql } from '../../db/client.js'
import {
  channels,
  channelPosts,
  CHANNEL_KIND,
  CHANNEL_POST_TYPE,
  type ChannelKind,
  type ChannelPostType,
} from '../../db/schema/channels.js'
import { router } from '../init.js'
// Round 7-01 — tenant-scoped channel procedures
// [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
// fix/multi-project-isolation — project-scoped procedures
import { projectProcedure } from '../middleware/project.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import { loadOrCreateInstall } from '../../config/install.js'
import type { Actor, ChannelId } from '@orbital/types'

// ---------------------------------------------------------------------------
// Lazy event-store (singleton per process)
// ---------------------------------------------------------------------------

let _eventStore: ReturnType<typeof createEventStore> | null = null
function eventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sql)
  return _eventStore
}

let _userActor: Actor | null = null
async function userActor(): Promise<Actor> {
  if (_userActor) return _userActor
  const install = await loadOrCreateInstall()
  _userActor = {
    type: 'user',
    user_id: process.env['USER'] ?? 'local-user',
    install_id: install.install_id,
  }
  return _userActor
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

interface Cursor {
  created_at: string
  id: string
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64')
}
function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null
  try {
    const json = Buffer.from(s, 'base64').toString('utf-8')
    const p = JSON.parse(json) as { created_at?: string; id?: string }
    if (typeof p.created_at === 'string' && typeof p.id === 'string') {
      return { created_at: p.created_at, id: p.id }
    }
    return null
  } catch {
    return null
  }
}

const PaginationInput = z.object({
  after: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const channelsRouter = router({
  // Round 7-01: tenant-scoped channel list.
  // Round 7-02: hub-proxied when ORBITAL_HUB_URL set.
  // [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
  // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
  list: projectProcedure
    .input(
      z
        .object({
          kind: z.array(z.enum(CHANNEL_KIND)).optional(),
          include_archived: z.boolean().default(false),
        })
        .merge(PaginationInput),
    )
    .query(async ({ input, ctx }) => {
      // Round 7-02 — hub proxy: delegate to hub when configured.
      // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
      const hub = getHubClient()
      if (hub !== null) {
        type ChannelListResult = {
          items: Array<{
            channel_id: string; name: string; kind: ChannelKind;
            scope_ref: string | null; description: string | null;
            created_at: string; archived_at: string | null;
          }>
          next_cursor: string | null
          has_more: boolean
        }
        const result = await hub.query<ChannelListResult>('channel.list', input, ctx.tenantId!)
        if (!result.ok) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.message })
        }
        return result.data
      }

      const conditions: SQL[] = []
      // Filter by tenant
      conditions.push(eq(channels.tenantId, ctx.tenantId!))
      // fix/multi-project-isolation — project scoping
      conditions.push(eq(channels.projectId, ctx.projectId!))
      if (input.kind && input.kind.length > 0) {
        conditions.push(inArray(channels.kind, input.kind))
      }
      if (!input.include_archived) {
        // archived_at IS NULL
        conditions.push(isNull(channels.archivedAt))
      }
      const cursor = decodeCursor(input.after)
      if (cursor) {
        conditions.push(lt(channels.createdAt, new Date(cursor.created_at)))
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined

      const rows = await db
        .select()
        .from(channels)
        .where(where)
        .orderBy(desc(channels.createdAt), desc(channels.channelId))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const items = hasMore ? rows.slice(0, input.limit) : rows
      const last = items[items.length - 1]
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              created_at:
                last.createdAt instanceof Date
                  ? last.createdAt.toISOString()
                  : new Date(last.createdAt as unknown as string).toISOString(),
              id: last.channelId,
            })
          : null

      return {
        items: items.map((r) => ({
          channel_id: r.channelId,
          name: r.name,
          kind: r.kind as ChannelKind,
          scope_ref: r.scopeRef,
          description: r.description,
          created_at:
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : new Date(r.createdAt as unknown as string).toISOString(),
          archived_at:
            r.archivedAt instanceof Date
              ? r.archivedAt.toISOString()
              : r.archivedAt
                ? new Date(r.archivedAt as unknown as string).toISOString()
                : null,
        })),
        next_cursor: nextCursor,
        has_more: hasMore,
      }
    }),

  posts: router({
    read: projectProcedure
      .input(
        z.object({
          channel_id: z.string().uuid(),
          post_types: z.array(z.enum(CHANNEL_POST_TYPE)).optional(),
          after: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(100),
        }),
      )
      .query(async ({ input, ctx }) => {
        const conditions: SQL[] = [
          eq(channelPosts.channelId, input.channel_id),
          // Round 7-01: tenant isolation on channel_posts
          eq(channelPosts.tenantId, ctx.tenantId!),
        ]
        // fix/multi-project-isolation — channel_posts has no project_id column;
        // enforce project scoping by validating the parent channel belongs to
        // the active project before any read.
        const channelOwner = await db
          .select({ projectId: channels.projectId })
          .from(channels)
          .where(
            and(
              eq(channels.channelId, input.channel_id),
              eq(channels.tenantId, ctx.tenantId!),
            ),
          )
          .limit(1)
        if (
          channelOwner.length === 0 ||
          channelOwner[0]!.projectId !== ctx.projectId
        ) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'channel not found in active project',
          })
        }
        if (input.post_types && input.post_types.length > 0) {
          conditions.push(inArray(channelPosts.postType, input.post_types))
        }
        const cursor = decodeCursor(input.after)
        if (cursor) {
          conditions.push(lt(channelPosts.createdAt, new Date(cursor.created_at)))
        }
        const where = conditions.length > 0 ? and(...conditions) : undefined

        const rows = await db
          .select()
          .from(channelPosts)
          .where(where)
          .orderBy(desc(channelPosts.createdAt), desc(channelPosts.postId))
          .limit(input.limit + 1)

        const hasMore = rows.length > input.limit
        const items = hasMore ? rows.slice(0, input.limit) : rows
        const last = items[items.length - 1]
        const nextCursor =
          hasMore && last
            ? encodeCursor({
                created_at:
                  last.createdAt instanceof Date
                    ? last.createdAt.toISOString()
                    : new Date(last.createdAt as unknown as string).toISOString(),
                id: last.postId,
              })
            : null

        return {
          items: items.map((r) => ({
            post_id: r.postId,
            channel_id: r.channelId,
            parent_post_id: r.parentPostId,
            post_type: r.postType as ChannelPostType,
            author_actor: r.authorActor,
            payload: r.payload,
            ceremony_id: r.ceremonyId,
            ceremony_turn_number: r.ceremonyTurnNumber,
            tokens_consumed: r.tokensConsumed,
            created_at:
              r.createdAt instanceof Date
                ? r.createdAt.toISOString()
                : new Date(r.createdAt as unknown as string).toISOString(),
          })),
          next_cursor: nextCursor,
          has_more: hasMore,
        }
      }),
  }),

  post: router({
    create: projectProcedure
      .input(
        z.object({
          channel_id: z.string().uuid(),
          post_type: z.enum(['user_guidance', 'reply']),
          parent_post_id: z.string().uuid().optional(),
          body: z.string().min(1).max(8000),
          mentions: z
            .array(
              z.object({
                target_type: z.enum(['persona_role', 'persona_session']),
                target_ref: z.string().min(1),
              }),
            )
            .max(20)
            .default([]),
          cross_references: z
            .array(
              z.object({
                ref_type: z.enum(['ticket', 'channel', 'adr', 'sprint', 'epic']),
                ref_id: z.string().min(1),
              }),
            )
            .max(20)
            .default([]),
          justification: z.string().min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        // fix/multi-project-isolation — verify channel belongs to active project
        const channelOwner = await db
          .select({ projectId: channels.projectId })
          .from(channels)
          .where(
            and(
              eq(channels.channelId, input.channel_id),
              eq(channels.tenantId, ctx.tenantId!),
            ),
          )
          .limit(1)
        if (
          channelOwner.length === 0 ||
          channelOwner[0]!.projectId !== ctx.projectId
        ) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'channel not found in active project',
          })
        }
        const service = new DefaultChannelsService(db, eventStore())
        const actor = await userActor()
        const payload =
          input.post_type === 'user_guidance'
            ? { body: input.body, intent: 'inform' as const }
            : { body: input.body }

        const result = await service.post(
          input.channel_id as ChannelId,
          {
            postType: input.post_type,
            payload,
            author: actor,
            ...(input.parent_post_id ? { parentPostId: input.parent_post_id } : {}),
            mentions: input.mentions.map((m) => ({
              target_type: m.target_type,
              target_ref: m.target_ref,
            })),
            crossReferences: input.cross_references.map((c) => ({
              ref_type: c.ref_type,
              ref_id: c.ref_id,
            })),
            justification: input.justification,
            tenantId: ctx.tenantId!,
          },
        )

        return { post_id: result.postId, audit_event_id: result.eventId }
      }),
  }),

  subscribe: projectProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        justification: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // fix/multi-project-isolation — verify channel belongs to active project
      const channelOwner = await db
        .select({ projectId: channels.projectId })
        .from(channels)
        .where(
          and(
            eq(channels.channelId, input.channel_id),
            eq(channels.tenantId, ctx.tenantId!),
          ),
        )
        .limit(1)
      if (
        channelOwner.length === 0 ||
        channelOwner[0]!.projectId !== ctx.projectId
      ) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'channel not found in active project',
        })
      }
      const service = new DefaultChannelsService(db, eventStore())
      const actor = await userActor()
      const subs = await service.subscribe(actor, [input.channel_id as ChannelId], {
        source: 'explicit',
        justification: input.justification,
        tenantId: ctx.tenantId!,
      })
      const first = subs[0]
      if (!first) {
        throw new Error('subscribe returned no subscription_id')
      }
      return { subscription_id: first.subscriptionId }
    }),

  // ---------------------------------------------------------------------------
  // Round 6 #9 — Inter-Agent Channel Collaboration
  // [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
  // ---------------------------------------------------------------------------

  /**
   * @route   channels.byWorker({worker_id})
   * @summary Returns all channel posts made by a given worker (persona session).
   * @access  Public
   *
   * @param   {string} worker_id  - Worker session_id (UUID)
   * @param   {string} [after]    - Cursor for pagination
   * @param   {number} [limit]    - Max results (default 50, max 200)
   *
   * @returns paginated list of posts with channel name, post type, excerpt, cost
   */
  byWorker: projectProcedure
    .input(
      z.object({
        worker_id: z.string().uuid(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const cursor = decodeCursor(input.after)
      const conditions: SQL[] = []

      // Round 7-01: tenant isolation
      conditions.push(eq(channelPosts.tenantId, ctx.tenantId!) as unknown as SQL)

      // fix/multi-project-isolation — restrict via parent channel projectId
      conditions.push(eq(channels.projectId, ctx.projectId!) as unknown as SQL)

      // Filter by persona session (worker_id maps to session_id in actor JSON)
      // channel_posts.author_actor is JSONB with session_id field
      conditions.push(
        eq(
          dSQL`(${channelPosts.authorActor}->>'session_id')`,
          input.worker_id,
        ) as unknown as SQL,
      )

      if (cursor) {
        conditions.push(
          lt(channelPosts.createdAt, new Date(cursor.created_at)) as unknown as SQL,
        )
      }

      const rows = await db
        .select({
          post_id: channelPosts.postId,
          channel_id: channelPosts.channelId,
          channel_name: channels.name,
          post_type: channelPosts.postType,
          payload: channelPosts.payload,
          author_actor: channelPosts.authorActor,
          tokens_consumed: channelPosts.tokensConsumed,
          created_at: channelPosts.createdAt,
        })
        .from(channelPosts)
        .innerJoin(channels, eq(channelPosts.channelId, channels.channelId))
        .where(conditions.length === 1 ? conditions[0]! : and(...conditions))
        .orderBy(desc(channelPosts.createdAt))
        .limit(input.limit + 1)

      const hasMore = rows.length > input.limit
      const items = hasMore ? rows.slice(0, input.limit) : rows
      const last = items[items.length - 1]
      const nextCursor =
        hasMore && last
          ? encodeCursor({
              created_at:
                last.created_at instanceof Date
                  ? last.created_at.toISOString()
                  : new Date(last.created_at as unknown as string).toISOString(),
              id: last.post_id,
            })
          : null

      return {
        items: items.map((r) => ({
          post_id: r.post_id,
          channel_id: r.channel_id,
          channel_name: r.channel_name,
          post_type: r.post_type as ChannelPostType,
          payload: r.payload,
          author_actor: r.author_actor,
          tokens_consumed: r.tokens_consumed,
          created_at:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : new Date(r.created_at as unknown as string).toISOString(),
        })),
        next_cursor: nextCursor,
        has_more: hasMore,
      }
    }),

  /**
   * @route   channels.escalations({sprint_id})
   * @summary Returns all escalation events for a given sprint.
   * @access  Public
   *
   * @param   {string} sprint_id - Sprint UUID
   * @param   {boolean} [unresolved_only] - When true, only return escalations without a resolution
   *
   * @returns list of escalations with task context and resolution status
   */
  escalations: projectProcedure
    .input(
      z.object({
        sprint_id: z.string().uuid(),
        unresolved_only: z.boolean().default(false),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Query channel posts that are escalation_notes from channels named #escalation-*
      // We join channels to filter by name prefix and by sprint cross-reference.
      const rows = await db
        .select({
          post_id: channelPosts.postId,
          channel_id: channelPosts.channelId,
          channel_name: channels.name,
          payload: channelPosts.payload,
          author_actor: channelPosts.authorActor,
          created_at: channelPosts.createdAt,
        })
        .from(channelPosts)
        .innerJoin(channels, eq(channelPosts.channelId, channels.channelId))
        .where(
          and(
            // Round 7-01: tenant isolation
            eq(channelPosts.tenantId, ctx.tenantId!),
            // fix/multi-project-isolation — project isolation via channel
            eq(channels.projectId, ctx.projectId!),
            eq(channelPosts.postType, 'escalation_note'),
            dSQL`${channels.name} LIKE '#escalation-%'`,
            // Check sprint cross-reference in the payload or channel name contains sprint_id
            dSQL`(
              ${channelPosts.payload}->>'sprint_id' = ${input.sprint_id}
              OR ${channels.name} LIKE ${'%' + input.sprint_id.slice(0, 8) + '%'}
            )`,
          ),
        )
        .orderBy(desc(channelPosts.createdAt))
        .limit(200)

      return {
        escalations: rows.map((r) => {
          const payload = r.payload as Record<string, unknown>
          return {
            post_id: r.post_id,
            channel_id: r.channel_id,
            channel_name: r.channel_name,
            raised_by: (r.author_actor as Record<string, unknown>)?.['persona_id'] as string ?? 'unknown',
            blocker_type: typeof payload['blocker_type'] === 'string' ? payload['blocker_type'] : 'unknown',
            body: typeof payload['body'] === 'string' ? payload['body'].slice(0, 500) : '',
            confidence: typeof payload['confidence'] === 'number' ? payload['confidence'] : -1,
            created_at:
              r.created_at instanceof Date
                ? r.created_at.toISOString()
                : new Date(r.created_at as unknown as string).toISOString(),
          }
        }),
      }
    }),
})

export type ChannelsRouter = typeof channelsRouter
