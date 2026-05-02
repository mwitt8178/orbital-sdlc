/**
 * cors.integration.test.ts — Integration tests for CORS allowlist (Round 3 S1).
 *
 * Builds a minimal Fastify app that mirrors the production CORS registration
 * and asserts:
 *   1. Production with empty allowlist → cross-origin preflight is rejected.
 *   2. Production with explicit allowlist → only listed origins are allowed.
 *   3. Development → any origin is allowed.
 *
 * We don't drive the test through `buildApp()` because that requires the
 * full DI graph; the CORS registration itself is a thin layer over
 * @fastify/cors and the test just exercises that layer with the same opts
 * the production code passes in.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'

interface CorsConfig {
  origin: boolean | string[]
  credentials: boolean
  methods: string[]
  allowedHeaders: string[]
}

const DEFAULT_CORS_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'x-orbital-admin-token',
]

async function makeApp(config: CorsConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cors, config)
  app.get('/ping', async () => ({ ok: true }))
  await app.ready()
  return app
}

let app: FastifyInstance | null = null

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
})

describe('Round 3 S1 — CORS allowlist', () => {
  it('production with empty allowlist rejects cross-origin requests', async () => {
    app = await makeApp({
      origin: [],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: DEFAULT_CORS_HEADERS,
    })

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    })
    // No allow-origin header means the browser will block the request.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('production with explicit allowlist allows ONLY listed origins', async () => {
    app = await makeApp({
      origin: ['https://app.example.com'],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: DEFAULT_CORS_HEADERS,
    })

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://app.example.com',
    )

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('exposes Idempotency-Key in allowed headers (S5 dependency)', async () => {
    app = await makeApp({
      origin: ['https://app.example.com'],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: DEFAULT_CORS_HEADERS,
    })

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key,content-type',
      },
    })
    const allowedHeaders = (res.headers['access-control-allow-headers'] ??
      '') as string
    expect(allowedHeaders.toLowerCase()).toContain('idempotency-key')
  })

  it('development mode (origin: true) accepts any origin', async () => {
    app = await makeApp({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: DEFAULT_CORS_HEADERS,
    })

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://anything.local',
        'access-control-request-method': 'GET',
      },
    })
    // origin: true echoes the request's origin back.
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://anything.local',
    )
  })
})
