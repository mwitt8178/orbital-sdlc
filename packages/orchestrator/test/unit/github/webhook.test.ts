/**
 * Unit tests for github/webhook.ts
 *
 * Covers:
 *   1. verifyGithubSignature — valid signature, tampered body, wrong secret,
 *      missing header, header without sha256= prefix.
 *   2. registerGithubWebhook — throws when no secret provided.
 *   3. HTTP handler — 401 on bad signature, 200 on valid pull_request.closed+merged,
 *      200 (no-op) for unrecognized PR number.
 *
 * All DB calls are stubbed. No real Postgres required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { verifyGithubSignature, registerGithubWebhook } from '../../../src/github/webhook.js'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'super-secret-webhook-key'

function sign(body: string): string {
  const hex = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf-8')).digest('hex')
  return `sha256=${hex}`
}

// Minimal EventStore stub
function makeEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({
      event_id: 'evt-1',
      aggregate_id: 'task-1',
      aggregate_type: 'task',
      event_type: 'TaskMerged',
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

// Minimal DB stub — returns a task row when pr_number matches
// Round 6 #1: added update stub for PRMerged/PRClosed db writes
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
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
// verifyGithubSignature unit tests
// ---------------------------------------------------------------------------

describe('verifyGithubSignature', () => {
  it('returns true for a matching signature', () => {
    const body = JSON.stringify({ action: 'closed' })
    const sig = sign(body)
    expect(verifyGithubSignature(body, sig, SECRET)).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const body = JSON.stringify({ action: 'closed' })
    const sig = sign(body)
    const tampered = JSON.stringify({ action: 'opened' })
    expect(verifyGithubSignature(tampered, sig, SECRET)).toBe(false)
  })

  it('returns false for the wrong secret', () => {
    const body = JSON.stringify({ action: 'closed' })
    const sig = sign(body)
    expect(verifyGithubSignature(body, sig, 'wrong-secret')).toBe(false)
  })

  it('returns false when signature header is missing', () => {
    const body = JSON.stringify({ action: 'closed' })
    expect(verifyGithubSignature(body, undefined, SECRET)).toBe(false)
  })

  it('returns false when header lacks sha256= prefix', () => {
    const body = JSON.stringify({ action: 'closed' })
    const hex = createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyGithubSignature(body, hex, SECRET)).toBe(false) // missing prefix
  })

  it('accepts Buffer as rawBody', () => {
    const body = Buffer.from('{"test":true}', 'utf-8')
    const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
    expect(verifyGithubSignature(body, sig, SECRET)).toBe(true)
  })

  it('returns false for empty signature string', () => {
    const body = 'hello'
    expect(verifyGithubSignature(body, '', SECRET)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// registerGithubWebhook — startup validation
// ---------------------------------------------------------------------------

describe('registerGithubWebhook startup', () => {
  it('throws OrbitalError when secret is empty', () => {
    const app = Fastify({ logger: false })
    expect(() =>
      registerGithubWebhook(app, {
        secret: '',
        eventStore: makeEventStore(),
        db: makeDb() as never,
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// HTTP handler scenarios
// ---------------------------------------------------------------------------

describe('POST /api/v1/webhooks/github', () => {
  let app: ReturnType<typeof Fastify>
  let eventStore: EventStore

  beforeEach(async () => {
    eventStore = makeEventStore()
    app = Fastify({ logger: false })
    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore,
      db: makeDb(42) as never,
    })
    await app.ready()
  })

  it('returns 401 when signature is invalid', async () => {
    const body = JSON.stringify({ action: 'closed' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=badhash',
      },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
    const json = res.json<{ error: { code: string } }>()
    expect(json.error.code).toBe('WEBHOOK_INVALID_SIGNATURE')
  })

  it('returns 200 and emits TaskMerged for pull_request.closed merged=true', async () => {
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        merged: true,
      },
    })
    const sig = sign(body)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sig,
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(eventStore.append).toHaveBeenCalledOnce()
    const call = (eventStore.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Round 6 #1: event_type changed from TaskMerged → PRMerged
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    expect(call.event_type).toBe('PRMerged')
    expect(call.aggregate_id).toBe('task-abc-123')
  })

  it('returns 200 and emits PRClosed for pull_request.closed not merged', async () => {
    // Round 6 #1: closed-without-merge now emits PRClosed (was no-op)
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        merged: false,
      },
    })
    const sig = sign(body)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sig,
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    // PRClosed is now emitted for unmerged PR closes
    expect(eventStore.append).toHaveBeenCalledOnce()
    const call = (eventStore.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.event_type).toBe('PRClosed')
    expect(call.aggregate_id).toBe('task-abc-123')
  })

  it('returns 200 and logs warning when PR number has no matching task', async () => {
    // Use a DB that returns no task
    const emptyDb = makeDb(null)
    const freshApp = Fastify({ logger: false })
    const freshStore = makeEventStore()
    registerGithubWebhook(freshApp, {
      secret: SECRET,
      eventStore: freshStore,
      db: emptyDb as never,
    })
    await freshApp.ready()

    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        number: 999,
        html_url: 'https://github.com/owner/repo/pull/999',
        merged: true,
      },
    })
    const sig = sign(body)

    const res = await freshApp.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sig,
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(freshStore.append).not.toHaveBeenCalled()
  })
})
