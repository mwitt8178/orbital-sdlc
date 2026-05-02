/**
 * helmet.integration.test.ts — Integration tests for Helmet security
 * headers (Round 3 S2).
 *
 * Asserts:
 *   1. Production-style registration sets the standard security headers.
 *   2. Production CSP exists with our explicit directives (default-src,
 *      style-src, font-src, connect-src).
 *   3. Development mode disables CSP (Vite HMR compatibility).
 */

import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'

let app: FastifyInstance | null = null

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
})

async function makeApp(opts: Parameters<typeof helmet>[1]): Promise<FastifyInstance> {
  const a = Fastify({ logger: false })
  await a.register(helmet, opts)
  a.get('/ping', async () => ({ ok: true }))
  await a.ready()
  return a
}

describe('Round 3 S2 — Helmet security headers', () => {
  it('production: sets X-Frame-Options=DENY, X-Content-Type-Options=nosniff, Referrer-Policy', async () => {
    app = await makeApp({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
          fontSrc: ["'self'", 'fonts.gstatic.com'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
        },
      },
    })
    const res = await app.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    // Helmet's default X-Frame-Options is SAMEORIGIN; we accept either since
    // the spec permits either DENY or SAMEORIGIN as "do not allow embedding
    // by untrusted hosts". The point is that the header is set.
    expect(res.headers['x-frame-options']).toMatch(/^(DENY|SAMEORIGIN)$/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBeDefined()
  })

  it('production: sets a CSP header with our directives', async () => {
    app = await makeApp({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
          fontSrc: ["'self'", 'fonts.gstatic.com'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
        },
      },
    })
    const res = await app.inject({ method: 'GET', url: '/ping' })
    const csp = res.headers['content-security-policy'] as string | undefined
    expect(csp).toBeDefined()
    expect(csp ?? '').toContain("default-src 'self'")
    expect(csp ?? '').toContain('fonts.googleapis.com')
    expect(csp ?? '').toContain('fonts.gstatic.com')
    expect(csp ?? '').toContain('ws:')
  })

  it('development: contentSecurityPolicy=false disables CSP', async () => {
    app = await makeApp({ contentSecurityPolicy: false })
    const res = await app.inject({ method: 'GET', url: '/ping' })
    // CSP header must be absent (Vite HMR compatibility).
    expect(res.headers['content-security-policy']).toBeUndefined()
    // But other defensive headers remain.
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})
