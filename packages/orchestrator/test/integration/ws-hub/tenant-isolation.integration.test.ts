/**
 * test/integration/ws-hub/tenant-isolation.integration.test.ts
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * AC4: subscriber on tenant A does NOT receive events from tenant B.
 *      Parameterised over multiple subscription pattern types.
 *
 * Critical security invariant: cross-tenant WS leakage = critical bug.
 *
 * No mocks; real Fastify, real EventStore, real WebSocket, real Postgres.
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

const TENANT_A = uuidv7()
const TENANT_B = uuidv7()

let sqlPool: postgres.Sql
let dbClient: ReturnType<typeof drizzle>
let store: PostgresEventStore
let hub: HubModeWebSocketHub
let app: ReturnType<typeof Fastify>
let port: number

interface TestInstall {
  installId: string
  privateKey: Uint8Array
  tenantId: string
}

async function seedInstall(tenantId: string): Promise<TestInstall> {
  const priv = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(priv)
  const pubB64 = bytesToBase64Url(pub)
  const installId = uuidv7()

  await dbClient.insert(knownInstalls).values({
    install_id: installId,
    tenant_id: tenantId,
    public_key: pubB64,
    role: 'member',
    display_name: `isolation-test-${tenantId.slice(0, 8)}`,
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: null,
  })

  return { installId, privateKey: priv, tenantId }
}

async function openWsForInstall(install: TestInstall): Promise<WebSocket> {
  const env = await signEnvelope({
    method: 'ws.connect',
    bodyBytes: new Uint8Array(0),
    privateKey: install.privateKey,
  })
  const params = new URLSearchParams({
    install_id: install.installId,
    sig: env.signatureB64,
    sig_body: env.bodyB64,
  })
  const url = `ws://127.0.0.1:${port}/ws?${params.toString()}`
  const ws = new WebSocket(url)

  // Wait for hello ack
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

async function subscribeWs(ws: WebSocket, patterns: string[]): Promise<void> {
  ws.send(JSON.stringify({ type: 'subscribe', patterns }))
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

function makeEventForTenant(tenantId: string, overrides: Partial<EventInput> & { tenant_id?: string } = {}): EventInput {
  const { payload: extraPayload, ...rest } = overrides
  return {
    aggregate_id: uuidv7(),
    aggregate_type: 'task',
    event_type: 'TaskStateChanged',
    // tenant_id travels in the payload so fanout can isolate per-tenant
    payload: { state: 'done', tenant_id: tenantId, ...(extraPayload ?? {}) },
    actor: { type: 'system', component: 'orchestrator' },
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
}, 30_000)

afterAll(async () => {
  await hub.stop()
  await app.close()
  await store.stopNotifyClient()
  await sqlPool`DELETE FROM known_installs WHERE tenant_id = ${TENANT_A}`
  await sqlPool`DELETE FROM known_installs WHERE tenant_id = ${TENANT_B}`
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------

describe('WS Hub — tenant isolation (AC4)', () => {
  it('tenant A subscriber does NOT receive tenant B task event', async () => {
    const installA = await seedInstall(TENANT_A)
    const installB = await seedInstall(TENANT_B)

    const taskId = uuidv7()
    const wsA = await openWsForInstall(installA)

    await subscribeWs(wsA, [`task:${taskId}`])

    let leakedToA = false
    wsA.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>
      if (m['ws_type'] === 'event') {
        const payload = m['payload'] as Record<string, unknown>
        if (payload['aggregate_id'] === taskId) leakedToA = true
      }
    })

    // tenant B appends an event for the same taskId
    await store.append(makeEventForTenant(TENANT_B, {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskStateChanged',
    }))

    // Wait 300ms to confirm no delivery to A
    await new Promise((r) => setTimeout(r, 300))
    expect(leakedToA).toBe(false)

    wsA.close()
    installB // suppress unused warning
  })

  it('tenant A subscriber receives tenant A events for same task', async () => {
    const installA = await seedInstall(TENANT_A)
    const taskId = uuidv7()
    const wsA = await openWsForInstall(installA)

    await subscribeWs(wsA, [`task:${taskId}`])

    const eventPromise = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 500)
      wsA.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (m['ws_type'] === 'event') {
          const payload = m['payload'] as Record<string, unknown>
          if (payload['aggregate_id'] === taskId) { clearTimeout(t); resolve(true) }
        }
      })
    })

    await store.append(makeEventForTenant(TENANT_A, {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskStateChanged',
    }))

    const received = await eventPromise
    expect(received).toBe(true)

    wsA.close()
  })

  it.each([
    { label: 'task', patternFn: (id: string) => `task:${id}` },
    { label: 'channel', patternFn: (id: string) => `channel:${id}` },
    { label: 'project:events', patternFn: (id: string) => `project:${id}:events` },
  ])(
    'tenant isolation holds for $label subscriptions — cross-tenant event not delivered',
    async ({ patternFn }) => {
      const installA = await seedInstall(TENANT_A)
      const resourceId = uuidv7()
      const wsA = await openWsForInstall(installA)

      await subscribeWs(wsA, [patternFn(resourceId)])

      let leaked = false
      wsA.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        if (m['ws_type'] === 'event') leaked = true
      })

      // Append matching event for TENANT_B
      await store.append(makeEventForTenant(TENANT_B, {
        aggregate_id: resourceId,
        aggregate_type: 'task',
        event_type: 'TaskStateChanged',
        payload: { project_id: resourceId, channel_id: resourceId, channel_name: resourceId },
      }))

      await new Promise((r) => setTimeout(r, 300))
      expect(leaked).toBe(false)

      wsA.close()
    },
  )
})
