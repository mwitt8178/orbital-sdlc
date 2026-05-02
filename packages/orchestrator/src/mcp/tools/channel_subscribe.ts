/**
 * MCP tool: channel.subscribe
 *
 * Per TRD-05 §6.2 (channel.subscribe is the explicit-subscription tool).
 *
 * Capability-gated by `channel_read` scope on the target channel name.
 * Emits ChannelSubscribed.
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import type { MCPTool, ToolContext } from '../registry.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import type { Actor } from '@orbital/types'

const ChannelSubscribeInputSchema = z.object({
  channel: z.string().min(1),
  task_id: z.string().uuid().optional(),
  justification: z.string().min(1),
})

const ChannelSubscribeOutputSchema = z.object({
  subscription_id: z.string().uuid(),
})

export const channelSubscribeTool: MCPTool<
  typeof ChannelSubscribeInputSchema,
  typeof ChannelSubscribeOutputSchema
> = {
  name: 'channel.subscribe',
  description:
    'Subscribe an actor to a channel. Capability-gated by channel_read scope. Emits ChannelSubscribed.',
  inputSchema: ChannelSubscribeInputSchema,
  outputSchema: ChannelSubscribeOutputSchema,
  bypassScopeCheck: false,

  async handler(input, ctx: ToolContext) {
    const { channel, task_id } = input
    const { db, eventStore, bundle } = ctx

    const service = new DefaultChannelsService(db, eventStore)
    const target = await service.getByName(channel.startsWith('#') ? channel : `#${channel}`)
    if (!target) {
      throw new OrbitalError('NOT_FOUND_CHANNEL', `channel '${channel}' not found`)
    }

    const subscriber: Actor = {
      type: 'persona',
      persona_id: bundle.persona_id,
      session_id: bundle.session_id,
      ...(bundle.task_id !== undefined ? { task_id: bundle.task_id } : {}),
    }

    const subs = await service.subscribe(subscriber, [target.channelId], {
      ...(task_id ? { taskId: task_id } : bundle.task_id ? { taskId: bundle.task_id } : {}),
      capability: bundle,
      source: 'explicit',
    })

    const first = subs[0]
    if (!first) {
      throw new OrbitalError(
        'INTERNAL_ERROR',
        'channel.subscribe returned no subscription_id',
      )
    }
    return { subscription_id: first.subscriptionId }
  },
}
