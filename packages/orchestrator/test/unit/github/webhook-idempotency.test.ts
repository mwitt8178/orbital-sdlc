/**
 * Unit tests for GitHub webhook idempotency.
 *
 * Round 6 #6 — CI/CD Bridge
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Covers:
 *   1. Same delivery_id processed once (second call is a no-op).
 *   2. Different delivery_ids are each processed.
 *   3. DeliveryCache TTL eviction allows re-processing after expiry.
 *   4. HMAC: invalid signature returns 401.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import {
  verifyGithubSignature,
  registerGithubWebhook,
  DeliveryCache,
} from '../../../src/github/webhook.js'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'idempotency-test-secret'

function sign(body: string): string {
  const hex = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf-8')).digest('hex')
  return `sha256=${hex}`
}

function makeEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({
      event_id: 'evt-1',
      aggregate_id: 'task-1',
      aggregate_type: 'task',
      event_type: 'CIRunCompleted',
      payload: {},
      actor: { type: 'system', component: 'test' },
      trace_id: 'trace-1',
      occurred_at: new Date().toISOString(),
      ingested_at: new Date().toISOString(),
      schema_version: 1,
    }),
    query: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as EventStore
}

function makeDb(prNumber: number | null = 42): unknown {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(
      prNumber !== null ? [{ taskId: 'task-abc-123' }] : [],
    ),
  }
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  }
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
  }
}

// ---------------------------------------------------------------------------
// DeliveryCache unit tests
// ---------------------------------------------------------------------------

describe('DeliveryCache', () => {
  it('returns false for an unseen delivery_id (first call)', () => {
    const cache = new DeliveryCache({ ttlMs: 60_000 })
    expect(cache.hasSeen('delivery-1')).toBe(false)
  })

  it('returns true after markSeen is called', () => {
    const cache = new DeliveryCache({ ttlMs: 60_000 })
    cache.markSeen('delivery-1')
    expect(cache.hasSeen('delivery-1')).toBe(true)
  })

  it('two different delivery_ids are tracked independently', () => {
    const cache = new DeliveryCache({ ttlMs: 60_000 })
    cache.markSeen('delivery-1')
    expect(cache.hasSeen('delivery-1')).toBe(true)
    expect(cache.hasSeen('delivery-2')).toBe(false)
  })

  it('expires entries after TTL has elapsed', async () => {
    const cache = new DeliveryCache({ ttlMs: 10 }) // 10ms TTL
    cache.markSeen('delivery-1')
    expect(cache.hasSeen('delivery-1')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cache.hasSeen('delivery-1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Idempotency via HTTP handler
// ---------------------------------------------------------------------------

describe('Webhook idempotency (HTTP handler)', () => {
  let app: ReturnType<typeof Fastify>
  let eventStore: EventStore

  beforeEach(async () => {
    app = Fastify()
    eventStore = makeEventStore()
    const deliveryCache = new DeliveryCache({ ttlMs: 60_000 })
    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore,
      db: makeDb() as Parameters<typeof registerGithubWebhook>[1]['db'],
      deliveryCache,
    })
    await app.ready()
  })

  it('processes a check_run.completed event on first delivery', async () => {
    const payload = {
      action: 'completed',
      check_run: {
        id: 12345,
        name: 'test / vitest',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/repo/runs/12345',
        started_at: '2026-05-01T10:00:00Z',
        completed_at: '2026-05-01T10:02:12Z',
        head_sha: 'abc123def456',
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: 'owner/repo' },
    }
    const body = JSON.stringify(payload)
    const sig = sign(body)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': sig,
        'x-github-delivery': 'delivery-uuid-001',
      },
      body,
    })

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(eventStore.append)).toHaveBeenCalledOnce()
  })

  it('skips processing on duplicate delivery_id (idempotency)', async () => {
    const payload = {
      action: 'completed',
      check_run: {
        id: 12345,
        name: 'test / vitest',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/repo/runs/12345',
        started_at: '2026-05-01T10:00:00Z',
        completed_at: '2026-05-01T10:02:12Z',
        head_sha: 'abc123def456',
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: 'owner/repo' },
    }
    const body = JSON.stringify(payload)
    const sig = sign(body)

    // First request
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': sig,
        'x-github-delivery': 'delivery-uuid-dup',
      },
      body,
    })

    // Second request — same delivery_id
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': sig,
        'x-github-delivery': 'delivery-uuid-dup',
      },
      body,
    })

    expect(res.statusCode).toBe(200)
    // eventStore.append should only have been called once total
    expect(vi.mocked(eventStore.append)).toHaveBeenCalledOnce()
  })

  it('returns 401 for invalid HMAC signature', async () => {
    const payload = { action: 'completed', check_run: {} }
    const body = JSON.stringify(payload)
    const badSig = 'sha256=badhex000000000000000000000000000000000000000000000000000000000000'

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': badSig,
        'x-github-delivery': 'delivery-bad-sig',
      },
      body,
    })

    expect(res.statusCode).toBe(401)
  })
})
