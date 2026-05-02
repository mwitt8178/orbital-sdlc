/**
 * notfound.integration.test.ts — Integration test for the 404 envelope
 * (Round 3 S3).
 *
 * Builds a small Fastify app that mirrors the production setup:
 *   - errorHandler installed
 *   - setNotFoundHandler that emits the canonical Primitives §10 envelope
 *
 * Asserts that GET /nonexistent returns 404 with the expected envelope.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { errorHandler } from '../../../src/middleware/error-handler.js'

let app: FastifyInstance | null = null

afterEach(async () => {
  if (app) {
    await app.close()
    app = null
  }
})

describe('Round 3 S3 — 404 envelope', () => {
  it('returns the canonical Primitives §10 envelope for unknown routes', async () => {
    app = Fastify({ logger: false })
    app.setErrorHandler(errorHandler)
    app.setNotFoundHandler((req, reply) => {
      void reply.status(404).send({
        error: {
          code: 'NOT_FOUND_ROUTE',
          message: `Route ${req.method}:${req.url} not found`,
          trace_id: 'test-trace',
        },
      })
    })
    app.get('/known', async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    })

    expect(res.statusCode).toBe(404)
    const body = res.json() as {
      error?: { code?: string; message?: string; trace_id?: string }
    }
    expect(body.error?.code).toBe('NOT_FOUND_ROUTE')
    expect(body.error?.message).toContain('GET:/nonexistent')
    expect(body.error?.trace_id).toBeDefined()
  })

  it('does not interfere with known routes', async () => {
    app = Fastify({ logger: false })
    app.setErrorHandler(errorHandler)
    app.setNotFoundHandler((req, reply) => {
      void reply.status(404).send({
        error: {
          code: 'NOT_FOUND_ROUTE',
          message: `Route ${req.method}:${req.url} not found`,
          trace_id: 'test-trace',
        },
      })
    })
    app.get('/known', async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/known' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('captures POST and other methods in the envelope message', async () => {
    app = Fastify({ logger: false })
    app.setErrorHandler(errorHandler)
    app.setNotFoundHandler((req, reply) => {
      void reply.status(404).send({
        error: {
          code: 'NOT_FOUND_ROUTE',
          message: `Route ${req.method}:${req.url} not found`,
          trace_id: 'test-trace',
        },
      })
    })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/missing',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { error?: { message?: string } }
    expect(body.error?.message).toContain('POST:/missing')
  })
})
