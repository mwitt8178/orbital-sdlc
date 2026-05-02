/**
 * MCP tool: channel.post
 *
 * Per TRD-05 §6.2.3.
 *
 * Capability gated by `channel_post` scope on the target channel.
 * Validation: payload validated against the registered post-type schema in
 * comms/types.ts.
 *
 * The tool resolves the channel (id or name), invokes ChannelsService.post,
 * which writes the channel_posts row, mentions/cross_references rows, and
 * emits ChannelPostAdded + MentionDelivered events.
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import type { MCPTool, ToolContext } from '../registry.js'
import {
  CHANNEL_POST_TYPE,
  type ChannelPostType,
} from '../../db/schema/channels.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import type { ChannelId, Actor } from '@orbital/types'

const ChannelPostInputSchema = z.object({
  channel: z.string().min(1),
  post_type: z.enum(
    CHANNEL_POST_TYPE.filter(
      (t) => t !== 'system_event' && t !== 'capability_event',
    ) as [string, ...string[]],
  ),
  payload: z.record(z.string(), z.unknown()),
  parent_post_id: z.string().uuid().optional(),
  mentions: z
    .array(
      z.object({
        target_type: z.enum(['persona_role', 'user', 'persona_session']),
        target_ref: z.string().min(1),
      }),
    )
    .max(20)
    .default([]),
  cross_references: z
    .array(
      z.object({
        ref_type: z.enum(['ticket', 'channel', 'adr', 'sprint', 'epic', 'commit', 'ceremony', 'defect']),
        ref_id: z.string().min(1),
      }),
    )
    .max(20)
    .default([]),
  justification: z.string().min(1),
})

const ChannelPostOutputSchema = z.object({
  post_id: z.string().uuid(),
  audit_event_id: z.string(),
})

export const channelPostTool: MCPTool<typeof ChannelPostInputSchema, typeof ChannelPostOutputSchema> =
  {
    name: 'channel.post',
    description:
      'Post a typed message to a channel. Capability-gated by channel_post scope; payload validated against the registered post-type schema.',
    inputSchema: ChannelPostInputSchema,
    outputSchema: ChannelPostOutputSchema,
    bypassScopeCheck: false,

    async handler(input, ctx: ToolContext) {
      const { channel, post_type, payload, parent_post_id, mentions, cross_references, justification } = input
      const { db, eventStore, bundle } = ctx

      const service = new DefaultChannelsService(db, eventStore)
      // Resolve channel by name or id.
      const target =
        channel.startsWith('#') || /^[a-z0-9_-]+$/.test(channel)
          ? await service.getByName(channel.startsWith('#') ? channel : `#${channel}`)
          : await service.getById(channel as ChannelId)

      if (!target) {
        throw new OrbitalError('NOT_FOUND_CHANNEL', `channel '${channel}' not found`)
      }

      const author: Actor = {
        type: 'persona',
        persona_id: bundle.persona_id,
        session_id: bundle.session_id,
        ...(bundle.task_id !== undefined ? { task_id: bundle.task_id } : {}),
      }

      const result = await service.post(
        target.channelId,
        {
          postType: post_type as ChannelPostType,
          payload,
          author,
          ...(parent_post_id ? { parentPostId: parent_post_id } : {}),
          mentions,
          crossReferences: cross_references,
          capabilityId: bundle.capability_id,
          justification,
        },
        bundle,
      )

      return {
        post_id: result.postId,
        audit_event_id: result.eventId,
      }
    },
  }
