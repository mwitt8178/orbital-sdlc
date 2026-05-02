/**
 * Unit tests for the Monday webhook receiver.
 *
 * These tests exercise the signature verification helper and the registered
 * Fastify route. The route runs in-process via Fastify's `inject` API; no
 * TCP listener needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  registerBacklogWebhook,
  verifyMondaySignature,
} from '../../../src/backlog/webhook.js'
import type { MondaySyncService } from '../../../src/backlog/monday-sync.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSyncService(): MondaySyncService {
  const calls: Array<unknown> = []
  return {
    async onStoryCreated() {
      return { mondaySubitemId: '1' }
    },
    async onStoryStatusChanged() {
      return
    },
    async reconcile() {
      return { pulledCount: 0, driftCount: 0, boardId: 'b' }
    },
    async handleWebhookPayload(payload) {
      calls.push(payload)
      return { accepted: true }
    },
    // expose calls for assertions
    ...({ calls } as unknown as MondaySyncService),
  } as MondaySyncService & { calls: unknown[] }
}

const SECRET = 'super-secret-key'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex')
}

// ---------------------------------------------------------------------------
// Pure HMAC helper tests
// ---------------------------------------------------------------------------

describe('verifyMondaySignature', () => {
  it('returns true for matching HMAC', () => {
    const body = JSON.stringify({ event: { type: 'update_column_value' } })
    const sig = sign(body)
    expect(verifyMondaySignature(body, sig, SECRET)).toBe(true)
  })

  it('returns false for tampered body', () => {
    const body = JSON.stringify({ event: { type: 'update_column_value' } })
    const sig = sign(body)
    expect(verifyMondaySignature(body + 'X', sig, SECRET)).toBe(false)
  })

  it('returns false for wrong secret', () => {
    const body = JSON.stringify({ a: 1 })
    const sig = createHmac('sha256', 'wrong').update(body).digest('hex')
    expect(verifyMondaySignature(body, sig, SECRET)).toBe(false)
  })

  it('returns false when signature is undefined', () => {
    expect(verifyMondaySignature('body', undefined, SECRET)).toBe(false)
  })

  it('returns false when signature length differs', () => {
    expect(verifyMondaySignature('body', 'abc', SECRET)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fastify integration via .inject
// ---------------------------------------------------------------------------

describe('registerBacklogWebhook — Fastify route', () => {
  let app: FastifyInstance
  let syncService: MondaySyncService

  beforeAll(async () => {
    app = Fastify({ logger: false })
    syncService = makeSyncService()
    registerBacklogWebhook(app, { secret: SECRET, syncService })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 401 on missing x-monday-signature header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      payload: { event: { type: 'update_column_value' } },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    const body = res.json() as { error?: { code?: string } }
    expect(body.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE')
  })

  it('returns 401 on tampered body', async () => {
    const validBody = JSON.stringify({ event: { type: 'update_column_value' } })
    const sig = sign(validBody)
    // Send a different body but the signature for the original
    const tampered = JSON.stringify({ event: { type: 'malicious' } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      payload: tampered,
      headers: {
        'content-type': 'application/json',
        'x-monday-signature': sig,
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a properly signed challenge handshake', async () => {
    const payload = { challenge: 'hello' }
    const body = JSON.stringify(payload)
    const sig = sign(body)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-monday-signature': sig,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ challenge: 'hello' })
  })

  it('accepts a properly signed event and dispatches to sync service', async () => {
    const payload = { event: { type: 'update_column_value', pulseId: 'monday-1' } }
    const body = JSON.stringify(payload)
    const sig = sign(body)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/monday',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-monday-signature': sig,
      },
    })
    expect(res.statusCode).toBe(200)
    const calls = (syncService as MondaySyncService & { calls?: unknown[] }).calls
    expect(calls?.length).toBeGreaterThanOrEqual(1)
  })
})

describe('registerBacklogWebhook — config validation', () => {
  it('throws if secret is empty', () => {
    const app = Fastify({ logger: false })
    const sync = makeSyncService()
    expect(() => registerBacklogWebhook(app, { secret: '', syncService: sync })).toThrow()
  })
})
