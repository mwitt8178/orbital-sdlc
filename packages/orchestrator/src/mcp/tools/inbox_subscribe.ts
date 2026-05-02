/**
 * MCP tool: inbox.subscribe
 *
 * Per TRD-05 §6.2.1, §10.3.
 *
 * STREAMING tool: emits multiple notification frames for the lifetime of the
 * subscription, then a final response when the stream closes (per
 * protocol.ts streaming convention).
 *
 * Capability: each channel in `channels` must satisfy `channel_read`. We
 * validate per-channel inside the handler (the gateway's TOOL_TO_SCOPE_KEY
 * map only handles single-channel tools).
 *
 * The handler returns the initial stream_ready envelope synchronously.
 * The streamHandler yields subsequent inbox_post / buffer_truncated /
 * heartbeat envelopes until the consumer cancels.
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import type { MCPTool, ToolContext } from '../registry.js'
import { DefaultChannelsService } from '../../comms/channels.js'
import { DefaultInboxService } from '../../comms/inbox.js'
import { gatewayValidateChannel } from '../../capabilities/gateway.js'
import type { ChannelId } from '@orbital/types'

const InboxSubscribeInputSchema = z.object({
  channels: z.array(z.string().min(1)).min(1).max(50),
  cursor: z.string().optional(),
  buffer_cap: z.number().int().min(64).max(1024).default(256),
})

/** Handler returns a stream_ready envelope; the rest comes via streamHandler. */
const InboxSubscribeOutputSchema = z.object({
  kind: z.literal('stream_ready'),
  cursor: z.string(),
  resolved_channels: z.array(z.string().uuid()),
  server_time: z.string().datetime(),
})

export const inboxSubscribeTool: MCPTool<
  typeof InboxSubscribeInputSchema,
  typeof InboxSubscribeOutputSchema
> = {
  name: 'inbox.subscribe',
  description:
    'Long-lived push subscription: yields ChannelPostAdded events for subscribed channels. STREAMING.',
  inputSchema: InboxSubscribeInputSchema,
  outputSchema: InboxSubscribeOutputSchema,
  bypassScopeCheck: true, // we validate per-channel below
  streaming: true,

  async handler(input, ctx: ToolContext) {
    const { channels: channelRefs, cursor } = input
    const { db, eventStore, bundle } = ctx

    const service = new DefaultChannelsService(db, eventStore)

    // Resolve each channel to a channel id and validate channel_read scope.
    const resolved: ChannelId[] = []
    for (const ref of channelRefs) {
      const channel = ref.startsWith('#') || /^[a-z0-9_-]+$/.test(ref)
        ? await service.getByName(ref.startsWith('#') ? ref : `#${ref}`)
        : await service.getById(ref as ChannelId)

      if (!channel) {
        throw new OrbitalError('NOT_FOUND_CHANNEL', `channel '${ref}' not found`)
      }
      // Per-channel capability check.
      if (!gatewayValidateChannel(bundle, 'channel_read', channel.name)) {
        throw new OrbitalError(
          'AUTH_SCOPE_DENIED',
          `bundle lacks channel_read for '${channel.name}'`,
        )
      }
      resolved.push(channel.channelId)
    }

    return {
      kind: 'stream_ready' as const,
      cursor: cursor ?? '',
      resolved_channels: resolved,
      server_time: new Date().toISOString(),
    }
  },

  async *streamHandler(input, ctx: ToolContext) {
    const { channels: channelRefs, cursor, buffer_cap } = input
    const { db, eventStore } = ctx

    const channelService = new DefaultChannelsService(db, eventStore)
    const inboxService = new DefaultInboxService(db, eventStore)

    // Re-resolve channels (handler already validated capability).
    const resolved: ChannelId[] = []
    for (const ref of channelRefs) {
      const channel = ref.startsWith('#') || /^[a-z0-9_-]+$/.test(ref)
        ? await channelService.getByName(ref.startsWith('#') ? ref : `#${ref}`)
        : await channelService.getById(ref as ChannelId)
      if (channel) resolved.push(channel.channelId)
    }

    const sub = inboxService.subscribeAsStream(resolved, cursor ?? null, {
      bufferCap: buffer_cap,
    })
    const inner = sub.iterable[Symbol.asyncIterator]()

    // Cancellation flag + a Promise that resolves when sub.unsubscribe runs.
    // We `Promise.race` `inner.next()` against this Promise so that an early
    // unsubscribe() (driven by the gateway when the socket closes) lets the
    // generator exit even if no message ever arrives.
    let cancelled = false
    let cancelResolve: () => void = () => undefined
    const cancelPromise: Promise<'cancel'> = new Promise<'cancel'>((resolve) => {
      cancelResolve = (): void => resolve('cancel')
    })

    // Wrap sub.unsubscribe so it ALSO triggers our cancel signal.
    const localUnsubscribe = (): void => {
      if (cancelled) return
      cancelled = true
      sub.unsubscribe()
      cancelResolve()
    }

    try {
      while (!cancelled) {
        const winner = await Promise.race<IteratorResult<unknown> | 'cancel'>([
          inner.next(),
          cancelPromise,
        ])
        if (winner === 'cancel' || cancelled) break
        const next = winner as IteratorResult<{ kind?: string }>
        if (next.done) break
        const value = next.value as { kind?: string }
        // Skip the initial stream_ready (already returned by handler).
        if (value.kind === 'stream_ready') continue
        yield value
      }
    } finally {
      // Drives stopped=true + wake() inside subscribeAsStream's iterator,
      // so any in-flight inner.next() resolves immediately.
      localUnsubscribe()
      try {
        await inner.return?.(undefined)
      } catch {
        /* swallow — best-effort */
      }
    }
  },
}
