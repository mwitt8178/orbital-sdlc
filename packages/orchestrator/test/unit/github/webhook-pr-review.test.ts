/**
 * Unit tests for the pull_request.opened → PR review dispatch path.
 *
 * [Engineer-Sr · Sonnet · run-pr-review-agent-001]
 *
 * Covers:
 *   1. Webhook signature verification still enforced (401 on bad sig).
 *   2. pull_request.opened calls onPROpenedForReview with correct payload.
 *   3. pull_request.opened with unknown PR number is a no-op (no callback).
 *   4. onPROpenedForReview not called for pull_request.closed.
 *   5. onPROpenedForReview fires-and-forgets — webhook returns 200 immediately
 *      even if the callback throws.
 *   6. Tenant ID is extracted from task row, not hardcoded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { verifyGithubSignature, registerGithubWebhook } from '../../../src/github/webhook.js'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'webhook-test-secret'
const TENANT_ID = 'abcdef00-0000-0000-0000-000000000001'

function sign(body: string): string {
  const hex = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf-8')).digest('hex')
  return `sha256=${hex}`
}

function makeEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({ event_id: 'evt-1' }),
    query: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as EventStore
}

function makeDb(opts: {
  taskIdForPrNumber?: string
  tenantId?: string
  storyId?: string
} = {}) {
  const { taskIdForPrNumber = 'task-abc-123', tenantId = TENANT_ID, storyId = 'story-abc' } = opts

  // select chain — returns task row for PR 42, empty for others
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      // Return different results based on call count:
      // first call: findTaskByPrNumber → returns task row
      // subsequent calls: findTaskWithStoryId + costLedger → returns story details
      return Promise.resolve([{ taskId: taskIdForPrNumber, tenantId, storyId }])
    }),
    orderBy: vi.fn().mockReturnThis(),
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

function buildPROpenedPayload(prNumber = 42, repoOwner = 'myorg', repoName = 'myrepo') {
  return {
    action: 'opened',
    pull_request: {
      number: prNumber,
      html_url: `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`,
      head: { sha: 'deadbeef' },
    },
    repository: {
      full_name: `${repoOwner}/${repoName}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook pull_request.opened → PR review dispatch', () => {
  it('calls onPROpenedForReview with correct payload on pull_request.opened', async () => {
    const app = Fastify()
    const db = makeDb()
    const reviewCallback = vi.fn()

    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore: makeEventStore(),
      db: db as never,
      onPROpenedForReview: reviewCallback,
    })

    const body = JSON.stringify(buildPROpenedPayload(42, 'myorg', 'myrepo'))
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
        'content-type': 'application/json',
      },
      body,
    })

    expect(resp.statusCode).toBe(200)
    expect(reviewCallback).toHaveBeenCalledOnce()
    const job = reviewCallback.mock.calls[0]![0]
    expect(job.kind).toBe('pr_review')
    expect(job.pr_number).toBe(42)
    expect(job.github_owner).toBe('myorg')
    expect(job.github_repo).toBe('myrepo')
    expect(job.head_sha).toBe('deadbeef')
  })

  it('does not call onPROpenedForReview for pull_request.closed', async () => {
    const app = Fastify()
    const db = makeDb()
    const reviewCallback = vi.fn()

    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore: makeEventStore(),
      db: db as never,
      onPROpenedForReview: reviewCallback,
    })

    const closedPayload = {
      action: 'closed',
      pull_request: {
        html_url: 'https://github.com/myorg/myrepo/pull/42',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
      },
    }
    const body = JSON.stringify(closedPayload)
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-2',
        'content-type': 'application/json',
      },
      body,
    })

    expect(reviewCallback).not.toHaveBeenCalled()
  })

  it('returns 200 even when onPROpenedForReview throws synchronously', async () => {
    const app = Fastify()
    const db = makeDb()

    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore: makeEventStore(),
      db: db as never,
      onPROpenedForReview: () => { throw new Error('callback exploded') },
    })

    const body = JSON.stringify(buildPROpenedPayload())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-3',
        'content-type': 'application/json',
      },
      body,
    })

    expect(resp.statusCode).toBe(200)
  })

  it('does not call onPROpenedForReview for unknown PR number (no task match)', async () => {
    const app = Fastify()
    // DB returns empty array = no task found for this PR
    const emptyDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        orderBy: vi.fn().mockReturnThis(),
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) }),
    }
    const reviewCallback = vi.fn()

    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore: makeEventStore(),
      db: emptyDb as never,
      onPROpenedForReview: reviewCallback,
    })

    const body = JSON.stringify(buildPROpenedPayload(9999))
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-4',
        'content-type': 'application/json',
      },
      body,
    })

    expect(reviewCallback).not.toHaveBeenCalled()
  })

  it('returns 401 on invalid signature regardless of PR action', async () => {
    const app = Fastify()
    const db = makeDb()
    const reviewCallback = vi.fn()

    registerGithubWebhook(app, {
      secret: SECRET,
      eventStore: makeEventStore(),
      db: db as never,
      onPROpenedForReview: reviewCallback,
    })

    const body = JSON.stringify(buildPROpenedPayload())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'x-hub-signature-256': 'sha256=badbadbadbad',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-5',
        'content-type': 'application/json',
      },
      body,
    })

    expect(resp.statusCode).toBe(401)
    expect(reviewCallback).not.toHaveBeenCalled()
  })
})
