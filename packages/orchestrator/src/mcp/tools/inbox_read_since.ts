/**
 * MCP tool: inbox.read_since
 *
 * Per TRD-05 §6.2.2 (poll fallback).
 *
 * Synchronous backfill of channel_posts after a cursor. Used by:
 *   - Workers after `buffer_truncated` to backfill durable storage.
 *   - Test harnesses preferring synchronous calls.
 *   - Defensive backfill when streaming transport is unavailable.
 *
 * Capability: per-channel `channel_read` (validated inside handler since
 * params carry an array of channels).
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import type { MCPTool, ToolContext } from '../registry.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import { DefaultInboxService } from '../../comms/inbox.js'
import { gatewayValidateChannel } from '../../capabilities/gateway.js'
import type { ChannelId } from '@orbital/types'

const InboxReadSinceInputSchema = z.object({
  channels: z.array(z.string().min(1)).min(1).max(50),
  cursor: z.string(),
  limit: z.number().int().min(1).max(500).default(100),
})

const InboxReadSinceOutputSchema = z.object({
  messages: z.array(
    z.object({
      cursor: z.string(),
      post_id: z.string().uuid(),
      channel_id: z.string().uuid(),
      channel_name: z.string(),
      post_type: z.string(),
      payload: z.record(z.string(), z.unknown()),
      parent_post_id: z.string().nullable(),
      author: z.record(z.string(), z.unknown()),
      mentions: z.array(
        z.object({ target_type: z.string(), target_ref: z.string(), priority: z.number() }),
      ),
      cross_references: z.array(z.object({ ref_type: z.string(), ref_id: z.string() })),
      is_priority: z.boolean(),
      occurred_at: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
})

export const inboxReadSinceTool: MCPTool<
  typeof InboxReadSinceInputSchema,
  typeof InboxReadSinceOutputSchema
> = {
  name: 'inbox.read_since',
  description:
    'Synchronous backfill: returns posts in subscribed channels with event_id > cursor (UUIDv7-ordered). Cursors come from the InboxMessage.cursor field which equals the underlying ChannelPostAdded event_id.',
  inputSchema: InboxReadSinceInputSchema,
  outputSchema: InboxReadSinceOutputSchema,
  bypassScopeCheck: true, // per-channel validation inside

  async handler(input, ctx: ToolContext) {
    const { channels: channelRefs, cursor, limit } = input
    const { db, eventStore, bundle } = ctx

    const channelService = new DefaultChannelsService(db, eventStore)
    const inboxService = new DefaultInboxService(db, eventStore)

    const resolved: ChannelId[] = []
    for (const ref of channelRefs) {
      const channel = ref.startsWith('#') || /^[a-z0-9_-]+$/.test(ref)
        ? await channelService.getByName(ref.startsWith('#') ? ref : `#${ref}`)
        : await channelService.getById(ref as ChannelId)
      if (!channel) {
        throw new OrbitalError('NOT_FOUND_CHANNEL', `channel '${ref}' not found`)
      }
      if (!gatewayValidateChannel(bundle, 'channel_read', channel.name)) {
        throw new OrbitalError(
          'AUTH_SCOPE_DENIED',
          `bundle lacks channel_read for '${channel.name}'`,
        )
      }
      resolved.push(channel.channelId)
    }

    const page = await inboxService.readSince(resolved, cursor, { limit })

    return {
      messages: page.items.map((m) => ({
        cursor: m.cursor,
        post_id: m.postId,
        channel_id: m.channelId,
        channel_name: m.channelName,
        post_type: m.postType,
        payload: m.payload,
        parent_post_id: m.parentPostId,
        author: m.author,
        mentions: m.mentions.map((mm) => ({
          target_type: mm.targetType,
          target_ref: mm.targetRef,
          priority: mm.priority,
        })),
        cross_references: m.crossReferences.map((c) => ({ ref_type: c.refType, ref_id: c.refId })),
        is_priority: m.isPriority,
        occurred_at: m.occurredAt,
      })),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    }
  },
}
