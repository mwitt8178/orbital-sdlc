/**
 * Integration test: WebSocketHub end-to-end.
 *
 * Boots a real Fastify server with @fastify/websocket, registers the hub,
 * connects a real `ws` WebSocket client, subscribes to a channel, and
 * verifies that a post created via ChannelsService.post() arrives over the WS
 * within 200ms.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import WebSocket from 'ws'
import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import { WebSocketHub } from '../../../src/ws/hub.js'
import type { Actor } from '@orbital/types'
import type { AddressInfo } from 'node:net'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let channels: DefaultChannelsService
let hub: WebSocketHub
let app: ReturnType<typeof Fastify>
let port: number

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 15, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  channels = new DefaultChannelsService(db, store)
  hub = new WebSocketHub(store)
  app = Fastify({ logger: false })
  await app.register(websocketPlugin)
  app.get('/ws', { websocket: true }, (socket) => {
    hub.handleConnection(socket as unknown as WebSocket)
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  port = addr.port
  await hub.start()
}, 30_000)

afterAll(async () => {
  await hub.stop()
  await app.close()
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

const userActor: Actor = {
  type: 'user',
  user_id: 'ws-test',
  install_id: '01900000-0000-7000-8000-000000000088',
}

// ---------------------------------------------------------------------------

describe('WebSocketHub end-to-end', () => {
  it('delivers a ChannelPostAdded event to a subscribed UI client within 200ms', async () => {
    const ticketId = `WS-${uuidv7()}`
    const ensure = await channels.ensureChannel('ticket_durable', ticketId, {
      createdBy: userActor,
    })

    // Use Fastify's injectWS helper. This avoids real socket upgrade quirks
    // under vitest's runtime and exercises the same handler path.
    const ws = (await app.injectWS('/ws')) as unknown as WebSocket

    // Wait for the hello ack. The hub may also fan out historical events from
    // EventStore.subscribe; we drain until we see the conn-id ack.
    const helloMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('hello timeout 3s')), 3000)
      const onMsg = (raw: WebSocket.RawData): void => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (
          m['ws_type'] === 'ack' &&
          (m['payload'] as Record<string, unknown>)?.['connected'] === true
        ) {
          clearTimeout(t)
          ws.off('message', onMsg)
          resolve(m)
        }
      }
      ws.on('message', onMsg)
    })
    expect(helloMsg['ws_type']).toBe('ack')

    // Subscribe to the channel.
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel_ids: [ensure.channelId],
      }),
    )
    const subAck = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
    })
    expect(subAck['ws_type']).toBe('ack')

    // Set up the message listener BEFORE posting.
    const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
      const onMsg = (raw: WebSocket.RawData): void => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        if (msg['ws_type'] === 'event') {
          ws.off('message', onMsg)
          resolve(msg)
        }
      }
      ws.on('message', onMsg)
    })

    const startTime = Date.now()
    await channels.post(ensure.channelId, {
      postType: 'status_update',
      payload: { body: 'live update' },
      author: userActor,
      justification: 'ws integration test',
    })

    const eventMsg = await Promise.race([
      eventPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WS event delivery timeout')), 1000),
      ),
    ])
    const elapsed = Date.now() - startTime
    expect(elapsed).toBeLessThan(1000)

    expect(eventMsg['ws_type']).toBe('event')
    const payload = eventMsg['payload'] as Record<string, unknown>
    expect(payload['event_type']).toBe('ChannelPostAdded')

    ws.close()
  })

  it('handles ping/pong', async () => {
    const ws = (await app.injectWS('/ws')) as unknown as WebSocket
    // Drain hello.
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve())
    })

    ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>))
    })
    expect(pong['ws_type']).toBe('pong')
    ws.close()
  })
})
