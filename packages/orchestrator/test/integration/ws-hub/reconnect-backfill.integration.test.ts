/**
 * test/integration/ws-hub/reconnect-backfill.integration.test.ts
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * AC3: WS down for a period during which N events occurred. On reconnect,
 *      all N events are delivered (verify by event_id sequence).
 *
 * Approach:
 *   - Open WS, subscribe to task:X, track last_seen_event_id.
 *   - Forcefully close WS.
 *   - Append 5 events during the "down" window.
 *   - Reconnect with last_seen_event_id as backfill cursor.
 *   - Assert all 5 missed events arrive within 2s.
 *
 * No mocks; real Fastify, real EventStore, real WebSocket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'

import { PostgresEventStore } from '../../../src/events/store.js'
import { HubModeWebSocketHub } from '../../../src/ws/hub.js'
import { signEnvelope, bytesToBase64Url } from '../../../src/keys/envelope.js'
import { registerHubModeWsRoutes } from '../../../src/ws/server.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import type { EventInput } from '../../../src/events/types.js'

ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital@localhost:5432/orbital'

const TEST_TENANT_ID = uuidv7()

let sqlPool: postgres.Sql
let dbClient: ReturnType<typeof drizzle>
let store: PostgresEventStore
let hub: HubModeWebSocketHub
let app: ReturnType<typeof Fastify>
let port: number

let installPrivKey: Uint8Array
let installId: string

async function makeInstall(): Promise<void> {
  installPrivKey = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(installPrivKey)
  const pubB64 = bytesToBase64Url(pub)
  installId = uuidv7()

  await dbClient.insert(knownInstalls).values({
    install_id: installId,
    tenant_id: TEST_TENANT_ID,
    public_key: pubB64,
    role: 'member',
    display_name: 'backfill-test',
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: null,
  })
}

async function wsUrl(cursor?: string): Promise<string> {
  const env = await signEnvelope({
    method: 'ws.connect',
    bodyBytes: new Uint8Array(0),
    privateKey: installPrivKey,
  })
  const params = new URLSearchParams({
    install_id: installId,
    sig: env.signatureB64,
    sig_body: env.bodyB64,
  })
  if (cursor) params.set('cursor', cursor)
  return `ws://127.0.0.1:${port}/ws?${params.toString()}`
}

async function openAndAwaitHello(cursor?: string): Promise<WebSocket> {
  const url = await wsUrl(cursor)
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hello timeout')), 5000)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      const payload = m['payload'] as Record<string, unknown> | undefined
      if (m['ws_type'] === 'ack' && payload?.['connected'] === true) {
        clearTimeout(t)
        ws.off('message', onMsg)
        resolve()
      }
    }
    ws.on('message', onMsg)
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })
  return ws
}

async function subscribeAndAwaitAck(ws: WebSocket, patterns: string[], cursor?: string): Promise<void> {
  const msg: Record<string, unknown> = { type: 'subscribe', patterns }
  if (cursor) msg['cursor'] = cursor
  ws.send(JSON.stringify(msg))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sub ack timeout')), 3000)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'ack') {
        const payload = m['payload'] as Record<string, unknown>
        if (Array.isArray(payload['subscribed'])) { clearTimeout(t); ws.off('message', onMsg); resolve() }
      }
    }
    ws.on('message', onMsg)
  })
}

function makeTaskEvent(taskId: string): EventInput {
  return {
    aggregate_id: taskId,
    aggregate_type: 'task',
    event_type: 'TaskStateChanged',
    // tenant_id travels in payload — events table has no tenant_id column
    payload: { state: 'done', tenant_id: TEST_TENANT_ID },
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  }
}

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 3, idle_timeout: 15, onnotice: () => {} })
  dbClient = drizzle(sqlPool)
  store = new PostgresEventStore(dbClient, sqlPool)
  hub = new HubModeWebSocketHub(store)

  app = Fastify({ logger: false })
  await app.register(websocketPlugin)
  await registerHubModeWsRoutes(app, { hub, db: dbClient })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  port = addr.port
  await hub.start()

  await makeInstall()
}, 30_000)

afterAll(async () => {
  await hub.stop()
  await app.close()
  await store.stopNotifyClient()
  await sqlPool`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------

describe('WS Hub — reconnect backfill (AC3)', () => {
  it('delivers all missed events on reconnect with cursor', async () => {
    const taskId = uuidv7()

    // Step 1: Connect, subscribe, get a live event to establish last_seen
    const ws1 = await openAndAwaitHello()
    await subscribeAndAwaitAck(ws1, [`task:${taskId}`])

    let lastSeenEventId: string | null = null
    ws1.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'event') {
        const cursor = m['cursor']
        if (typeof cursor === 'string') lastSeenEventId = cursor
      }
    })

    // Append one event to establish a known cursor
    const seedEnvelope = await store.append(makeTaskEvent(taskId))
    lastSeenEventId = seedEnvelope.event_id

    // Wait briefly for the live event
    await new Promise((r) => setTimeout(r, 200))

    // Step 2: Close connection
    ws1.close()
    await new Promise((r) => setTimeout(r, 100))

    // Step 3: Append 5 events while disconnected
    const missedEventIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const env = await store.append(makeTaskEvent(taskId))
      missedEventIds.push(env.event_id)
    }

    // Step 4: Reconnect with cursor = lastSeenEventId
    const ws2 = await openAndAwaitHello(lastSeenEventId ?? undefined)
    await subscribeAndAwaitAck(ws2, [`task:${taskId}`], lastSeenEventId ?? undefined)

    // Step 5: Collect events within 2s
    const received: string[] = []
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 2000)
      ws2.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (m['ws_type'] === 'event') {
          const payload = m['payload'] as Record<string, unknown>
          const eventId = payload['event_id'] as string
          if (eventId && missedEventIds.includes(eventId)) {
            received.push(eventId)
            if (received.length >= missedEventIds.length) {
              clearTimeout(t)
              resolve()
            }
          }
        }
      })
    })

    // All 5 missed events must be delivered
    expect(received.length).toBe(5)
    // Verify all IDs are present (not necessarily ordered — backfill may batch)
    for (const id of missedEventIds) {
      expect(received).toContain(id)
    }

    ws2.close()
  }, 15_000)
})
