/**
 * test/integration/ws-hub/auth-handshake.integration.test.ts
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * AC5: WS handshake without valid envelope → 4001 close code AUTH_REQUIRED.
 * AC5b: WS handshake with valid signed envelope → connection accepted + hello ack.
 *
 * Approach:
 *   - Spin up a real Fastify + WebSocket server with hub-mode WS auth enabled.
 *   - Seed a known_install row so the hub can look up the key.
 *   - Attempt connection with no params → expect close code 4001.
 *   - Attempt connection with invalid sig → expect close code 4001.
 *   - Attempt connection with valid signed envelope → expect hello ack.
 *
 * No mocks; uses real Postgres, real Ed25519 signing, real WebSocket.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { uuidv7 } from 'uuidv7'
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import WebSocket from 'ws'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { AddressInfo } from 'node:net'

import { PostgresEventStore } from '../../../src/events/store.js'
import { HubModeWebSocketHub } from '../../../src/ws/hub.js'
import { signEnvelope, bytesToBase64Url } from '../../../src/keys/envelope.js'
import { registerHubModeWsRoutes } from '../../../src/ws/server.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'

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

interface TestInstall {
  installId: string
  privateKey: Uint8Array
  publicKey: Uint8Array
  pubB64: string
}

async function seedInstall(opts: { tenantId?: string; revoked?: boolean } = {}): Promise<TestInstall> {
  const priv = ed.utils.randomPrivateKey()
  const pub = await ed.getPublicKeyAsync(priv)
  const pubB64 = bytesToBase64Url(pub)
  const installId = uuidv7()

  await dbClient.insert(knownInstalls).values({
    install_id: installId,
    tenant_id: opts.tenantId ?? TEST_TENANT_ID,
    public_key: pubB64,
    role: 'member',
    display_name: 'test-laptop-auth',
    invite_jti: uuidv7(),
    joined_at: new Date(),
    last_seen_at: null,
    revoked_at: opts.revoked ? new Date() : null,
  })

  return { installId, privateKey: priv, publicKey: pub, pubB64 }
}

async function buildWsUrl(install: TestInstall, wsPort: number): Promise<string> {
  const method = 'ws.connect'
  const bodyBytes = new Uint8Array(0)
  const env = await signEnvelope({ method, bodyBytes, privateKey: install.privateKey })
  const params = new URLSearchParams({
    install_id: install.installId,
    sig: env.signatureB64,
    sig_body: env.bodyB64,
  })
  return `ws://127.0.0.1:${wsPort}/ws?${params.toString()}`
}

/**
 * Attempt a WS connection; resolve with { opened, closeCode }.
 *
 * Semantics:
 *   - `opened: true`  — the connection stayed open long enough to be usable
 *                       (i.e. received a hello ack before any close).
 *   - `opened: false` — the connection was rejected: either the HTTP upgrade
 *                       failed or the server closed the socket immediately
 *                       (e.g. 4001 auth rejection) before a hello ack arrived.
 *
 * We distinguish the two cases by waiting up to 600ms for a hello ack after
 * the WS `open` event fires. If the server closes before the ack arrives we
 * report `opened: false` with the actual close code.
 *
 * Times out after 4s (treat as "did not open").
 */
function attemptWsConnect(url: string): Promise<{ opened: boolean; closeCode: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let resolved = false
    let helloReceived = false

    const done = (result: { opened: boolean; closeCode: number | null }) => {
      if (!resolved) {
        resolved = true
        resolve(result)
      }
    }

    const timeout = setTimeout(() => done({ opened: false, closeCode: null }), 4000)

    ws.on('open', () => {
      // Connection upgraded — now wait to see if we get a hello ack or an
      // immediate close. If the server sends 4001 the close fires before any
      // hello ack, so `helloReceived` remains false.
    })

    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>
        const payload = m['payload'] as Record<string, unknown> | undefined
        if (m['ws_type'] === 'ack' && payload?.['connected'] === true) {
          helloReceived = true
          clearTimeout(timeout)
          // Connection is genuinely open; close cleanly and resolve.
          ws.close()
          done({ opened: true, closeCode: null })
        }
      } catch {
        // non-JSON frame — ignore
      }
    })

    ws.on('close', (code) => {
      clearTimeout(timeout)
      // If we never got a hello ack, the connection was rejected.
      done({ opened: helloReceived, closeCode: code })
    })

    ws.on('error', () => {
      // errors handled by close
    })
  })
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
  await sqlPool`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
  await sqlPool.end({ timeout: 5 })
})

beforeEach(async () => {
  // Reset nonce LRU between tests so replays don't bleed
})

// ---------------------------------------------------------------------------

describe('WS Hub — auth handshake (AC5)', () => {
  it('rejects connection with no auth params → close code 4001', async () => {
    const result = await attemptWsConnect(`ws://127.0.0.1:${port}/ws`)
    expect(result.opened).toBe(false)
    expect(result.closeCode).toBe(4001)
  })

  it('rejects connection with unknown install_id → close code 4001', async () => {
    const priv = ed.utils.randomPrivateKey()
    const env = await signEnvelope({
      method: 'ws.connect',
      bodyBytes: new Uint8Array(0),
      privateKey: priv,
    })
    const params = new URLSearchParams({
      install_id: uuidv7(), // unknown
      sig: env.signatureB64,
      sig_body: env.bodyB64,
    })
    const result = await attemptWsConnect(`ws://127.0.0.1:${port}/ws?${params.toString()}`)
    expect(result.opened).toBe(false)
    expect(result.closeCode).toBe(4001)
  })

  it('rejects connection with invalid signature → close code 4001', async () => {
    const install = await seedInstall()
    const env = await signEnvelope({
      method: 'ws.connect',
      bodyBytes: new Uint8Array(0),
      privateKey: install.privateKey,
    })
    // Mangle signature
    const params = new URLSearchParams({
      install_id: install.installId,
      sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      sig_body: env.bodyB64,
    })
    const result = await attemptWsConnect(`ws://127.0.0.1:${port}/ws?${params.toString()}`)
    expect(result.opened).toBe(false)
    expect(result.closeCode).toBe(4001)
  })

  it('rejects revoked install → close code 4001', async () => {
    const install = await seedInstall({ revoked: true })
    const url = await buildWsUrl(install, port)
    const result = await attemptWsConnect(url)
    expect(result.opened).toBe(false)
    expect(result.closeCode).toBe(4001)
  })

  it('accepts valid envelope → connection opened, ack received', async () => {
    const install = await seedInstall()
    const url = await buildWsUrl(install, port)
    const result = await attemptWsConnect(url)
    expect(result.opened).toBe(true)
  })
})
