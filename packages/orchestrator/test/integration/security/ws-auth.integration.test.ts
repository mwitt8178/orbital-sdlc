/**
 * ws-auth.integration.test.ts — Integration tests for WS auth (Round 3 S4).
 *
 * Approach:
 *   - Spin up a real Fastify server bound to localhost on an ephemeral port.
 *   - Register registerWsRoutes with token configured.
 *   - Use the `ws` library to attempt connections with:
 *       (a) no token             → upgrade rejected (401)
 *       (b) wrong token          → upgrade rejected (401)
 *       (c) valid header token   → upgrade accepts
 *       (d) valid query token    → upgrade accepts
 *   - Assert: rejected upgrades fail before the ws 'open' event fires;
 *     accepted upgrades produce an 'open' event.
 *
 * The hub used here is a stub that just counts connections — we don't
 * exercise the EventStore subscribe/fan-out path; that's covered elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { registerWsRoutes } from '../../../src/ws/server.js'
import type { WebSocketHub } from '../../../src/ws/hub.js'

const TEST_TOKEN = 'test-ws-token-secure-bytes'

class StubHub {
  public connections = 0
  // Match the WebSocketHub surface only as far as the route handler needs.
  handleConnection(_socket: WebSocket): void {
    this.connections++
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  connectedCount(): number {
    return this.connections
  }
}

interface TestServer {
  app: FastifyInstance
  port: number
  hub: StubHub
}

async function startServer(token?: string): Promise<TestServer> {
  const app = Fastify({ logger: false })
  const hub = new StubHub()
  const opts = token
    ? { hub: hub as unknown as WebSocketHub, token }
    : { hub: hub as unknown as WebSocketHub }
  await registerWsRoutes(app, opts)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine listening port')
  }
  return { app, port: address.port, hub }
}

async function attemptConnect(
  port: number,
  options: { headers?: Record<string, string>; query?: string } = {},
): Promise<{ opened: boolean; closeCode: number | null; statusCode: number | null }> {
  return new Promise((resolve) => {
    const url = options.query
      ? `ws://127.0.0.1:${port}/ws?${options.query}`
      : `ws://127.0.0.1:${port}/ws`
    const ws = new WebSocket(url, { headers: options.headers ?? {} })
    let opened = false
    let statusCode: number | null = null
    ws.on('open', () => {
      opened = true
      ws.close()
    })
    ws.on('unexpected-response', (_req, res) => {
      statusCode = res.statusCode ?? null
      resolve({ opened: false, closeCode: null, statusCode })
    })
    ws.on('close', (code) => {
      // unexpected-response already resolved if reached; otherwise this is normal close
      if (!opened) return
      resolve({ opened: true, closeCode: code, statusCode })
    })
    ws.on('error', () => {
      // The error fires alongside unexpected-response or after a normal close.
      // We rely on unexpected-response/close to resolve; this handler suppresses
      // the unhandled error.
    })
  })
}

describe('Round 3 S4 — WebSocket auth', () => {
  describe('with token configured', () => {
    let server: TestServer

    beforeAll(async () => {
      server = await startServer(TEST_TOKEN)
    })

    afterAll(async () => {
      await server.app.close()
    })

    it('rejects upgrade without a token (401)', async () => {
      const r = await attemptConnect(server.port)
      expect(r.opened).toBe(false)
      expect(r.statusCode).toBe(401)
    })

    it('rejects upgrade with the wrong token (401)', async () => {
      const r = await attemptConnect(server.port, {
        headers: { 'x-orbital-ws-token': 'definitely-wrong' },
      })
      expect(r.opened).toBe(false)
      expect(r.statusCode).toBe(401)
    })

    it('accepts upgrade with the correct header token', async () => {
      const r = await attemptConnect(server.port, {
        headers: { 'x-orbital-ws-token': TEST_TOKEN },
      })
      expect(r.opened).toBe(true)
    })

    it('accepts upgrade with the correct query-param token', async () => {
      const r = await attemptConnect(server.port, {
        query: `token=${encodeURIComponent(TEST_TOKEN)}`,
      })
      expect(r.opened).toBe(true)
    })
  })

  describe('without token configured (open mode)', () => {
    let server: TestServer

    beforeAll(async () => {
      server = await startServer()
    })

    afterAll(async () => {
      await server.app.close()
    })

    it('accepts ALL upgrades (dev convenience)', async () => {
      const r = await attemptConnect(server.port)
      expect(r.opened).toBe(true)
    })
  })
})
