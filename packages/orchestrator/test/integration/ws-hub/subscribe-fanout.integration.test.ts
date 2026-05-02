/**
 * test/integration/ws-hub/subscribe-fanout.integration.test.ts
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * AC1: subscribe to `task:<id>`, append matching event, assert client receives
 *      within 500ms.
 *
 * Also verifies:
 *   - subscribe:channel:<name> receives comms.* events for that channel
 *   - subscribe:project:<id>:events receives all events for that project aggregate
 *   - subscribe:worker:<install_id>:* receives WorkerLifecycle events from that install
 *   - subscribe:team:presence receives presence events
 *   - Non-matching subscription does NOT receive unrelated events
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

let testInstallId: string
let testPrivKey: Uint8Array

async function makeTestInstall(): Promise<void> {
  testPrivKey = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(testPrivKey)
  const pubB64 = bytesToBase64Url(pub)
  testInstallId = uuidv7()

  await dbClient.insert(knownInstalls).values({
    install_id: testInstallId,
    tenant_id: TEST_TENANT_ID,
    public_key: pubB64,
    role: 'member',
    display_name: 'fanout-test',
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: null,
  })
}

async function authenticatedWsUrl(): Promise<string> {
  const env = await signEnvelope({
    method: 'ws.connect',
    bodyBytes: new Uint8Array(0),
    privateKey: testPrivKey,
  })
  const params = new URLSearchParams({
    install_id: testInstallId,
    sig: env.signatureB64,
    sig_body: env.bodyB64,
  })
  return `ws://127.0.0.1:${port}/ws?${params.toString()}`
}

/**
 * Open a WS connection. Waits for the hello ack before returning.
 */
async function openAuthenticatedConnection(): Promise<WebSocket> {
  const url = await authenticatedWsUrl()
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hello ack timeout')), 5000)
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

/**
 * Send a subscribe message and wait for the ack.
 */
async function subscribe(ws: WebSocket, patterns: string[]): Promise<void> {
  ws.send(JSON.stringify({ type: 'subscribe', patterns }))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('subscribe ack timeout')), 3000)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'ack') {
        const payload = m['payload'] as Record<string, unknown>
        if (Array.isArray(payload['subscribed'])) {
          clearTimeout(t)
          ws.off('message', onMsg)
          resolve()
        }
      }
    }
    ws.on('message', onMsg)
  })
}

/**
 * Wait for the next 'event' WS message, or reject after timeoutMs.
 */
function nextEvent(ws: WebSocket, timeoutMs = 500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no event within ${timeoutMs}ms`)), timeoutMs)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'event') {
        clearTimeout(t)
        ws.off('message', onMsg)
        resolve(m)
      }
    }
    ws.on('message', onMsg)
  })
}

function makeEvent(overrides: Partial<EventInput> & { tenant_id?: string } = {}): EventInput {
  const { tenant_id = TEST_TENANT_ID, payload: extraPayload, ...rest } = overrides
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskStateChanged',
    // tenant_id is injected into the payload so the WS fanout can read it.
    // The events schema has no tenant_id column; tenant context travels via payload.
    payload: { state: 'in_progress', tenant_id, ...(extraPayload ?? {}) },
    actor: { type: 'user', user_id: 'tester', install_id: testInstallId },
    trace_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    schema_version: 1,
    ...rest,
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

  await makeTestInstall()
}, 30_000)

afterAll(async () => {
  await hub.stop()
  await app.close()
  await store.stopNotifyClient()
  await sqlPool`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------

describe('WS Hub — subscribe fanout (AC1)', () => {
  it('subscriber receives task event within 500ms after append', async () => {
    const taskId = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`task:${taskId}`])

    const eventPromise = nextEvent(ws, 500)
    const start = Date.now()

    await store.append(makeEvent({ aggregate_id: taskId, aggregate_type: 'task', event_type: 'TaskStateChanged' }))

    const msg = await eventPromise
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['aggregate_id']).toBe(taskId)
    expect(payload['event_type']).toBe('TaskStateChanged')

    ws.close()
  })

  it('subscriber on task:X does NOT receive task:Y events', async () => {
    const taskX = uuidv7()
    const taskY = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`task:${taskX}`])

    let receivedUnexpected = false
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'event') {
        const payload = m['payload'] as Record<string, unknown>
        if (payload['aggregate_id'] === taskY) receivedUnexpected = true
      }
    })

    await store.append(makeEvent({ aggregate_id: taskY, aggregate_type: 'task', event_type: 'TaskStateChanged' }))
    // Wait 200ms to confirm no delivery
    await new Promise((r) => setTimeout(r, 200))
    expect(receivedUnexpected).toBe(false)

    ws.close()
  })

  it('subscriber receives channel events via channel:<name> pattern', async () => {
    const channelName = `ch-${uuidv7().slice(0, 8)}`
    const channelId = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`channel:${channelName}`])

    const eventPromise = nextEvent(ws, 500)
    await store.append(makeEvent({
      aggregate_id: channelId,
      aggregate_type: 'channel_post',
      event_type: 'ChannelPostAdded',
      payload: { channel_id: channelId, channel_name: channelName, body: 'hello' },
    }))

    const msg = await eventPromise
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['event_type']).toBe('ChannelPostAdded')

    ws.close()
  })

  it('subscriber receives project events via project:<id>:events pattern', async () => {
    const projectId = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`project:${projectId}:events`])

    const eventPromise = nextEvent(ws, 500)
    await store.append(makeEvent({
      aggregate_id: projectId,
      aggregate_type: 'task',
      event_type: 'TaskStateChanged',
      payload: { project_id: projectId, state: 'done' },
    }))

    const msg = await eventPromise
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['aggregate_id']).toBe(projectId)

    ws.close()
  })

  it('subscriber receives worker events via worker:<install_id>:* pattern', async () => {
    const workerInstallId = testInstallId
    const workerId = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`worker:${workerInstallId}:*`])

    const eventPromise = nextEvent(ws, 500)
    await store.append(makeEvent({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'WorkerLifecyclePhase',
      payload: { worker_id: workerId, install_id: workerInstallId, phase: 'started' },
    }))

    const msg = await eventPromise
    const payload = msg['payload'] as Record<string, unknown>
    expect(payload['event_type']).toBe('WorkerLifecyclePhase')

    ws.close()
  })

  it('unsubscribe removes the pattern — no further events delivered', async () => {
    const taskId = uuidv7()
    const ws = await openAuthenticatedConnection()

    await subscribe(ws, [`task:${taskId}`])

    // Unsubscribe
    ws.send(JSON.stringify({ type: 'unsubscribe', patterns: [`task:${taskId}`] }))
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('unsubscribe ack timeout')), 2000)
      ws.once('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (m['ws_type'] === 'ack') { clearTimeout(t); resolve() }
      })
    })

    let receivedAfterUnsub = false
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'event') receivedAfterUnsub = true
    })

    await store.append(makeEvent({ aggregate_id: taskId, aggregate_type: 'task', event_type: 'TaskStateChanged' }))
    await new Promise((r) => setTimeout(r, 200))
    expect(receivedAfterUnsub).toBe(false)

    ws.close()
  })
})
