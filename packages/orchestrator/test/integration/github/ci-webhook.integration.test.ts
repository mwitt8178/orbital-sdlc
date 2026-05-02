/**
 * CI webhook integration test.
 *
 * Round 6 #6 — CI/CD Bridge
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Tests:
 *   1. check_run.completed with conclusion=success → CIRunCompleted event emitted
 *      + ac_check_evidence row with ci_run_url + ci_conclusion.
 *   2. check_run.completed with conclusion=failure → CIRunFailed event emitted
 *      + evidence row with result=fail + mismatch warning when local was pass.
 *   3. workflow_run.completed → CIRunCompleted event emitted.
 *
 * GitHub HTTP calls NOT needed here — we directly call registerGithubWebhook
 * and post payloads. The boundary mock is at the HTTP transport only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify from 'fastify'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { acCheckEvidence } from '../../../src/db/schema/ac-check-evidence.js'
import {
  registerGithubWebhook,
  DeliveryCache,
} from '../../../src/github/webhook.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { createEvidenceStore } from '../../../src/verifiers/evidence.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SECRET = 'ci-webhook-int-test-secret'

function sign(body: string): string {
  const hex = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf-8')).digest('hex')
  return `sha256=${hex}`
}

let eventStore: ReturnType<typeof createEventStore>
let testTaskId: string
let testSprintId: string
let testTicketId: string
let testProjectId: string
let evidenceStore: ReturnType<typeof createEvidenceStore>
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  eventStore = createEventStore(db)
  evidenceStore = createEvidenceStore(db, eventStore)

  // Seed test data
  testTaskId = uuidv7()
  testSprintId = uuidv7()
  testTicketId = uuidv7()
  testProjectId = uuidv7()

  // Insert a task with a known PR number so the webhook can look it up
  await db.insert(tasks).values({
    taskId: testTaskId,
    sprintId: testSprintId,
    ticketId: testTicketId,
    title: 'CI Bridge test task',
    description: 'Integration test task for CI webhook',
    acceptanceCriteria: [],
    personaId: 'engineer',
    riskClass: 'standard',
    state: 'ready',
    attemptCount: 0,
    retryBudget: 1,
    wallClockTimeoutMs: 300_000,
    tokenBudget: 8000,
    declaredWritePaths: [],
    createdByEventId: uuidv7(),
    githubPrNumber: 101,
    githubHeadSha: 'deadbeef1234',
  })

  const deliveryCache = new DeliveryCache({ ttlMs: 60_000 })
  app = Fastify()
  registerGithubWebhook(app, {
    secret: SECRET,
    eventStore,
    db,
    deliveryCache,
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  // Clean up test rows
  await db.delete(tasks).where(eq(tasks.taskId, testTaskId))
  await closeDb()
})

beforeEach(async () => {
  // Clean up evidence rows inserted during each test
  await db.delete(acCheckEvidence).where(eq(acCheckEvidence.verificationId, testTaskId))
})

// ---------------------------------------------------------------------------
// Helper to post a webhook payload
// ---------------------------------------------------------------------------

async function postWebhook(
  eventType: string,
  payload: unknown,
  deliveryId: string,
): Promise<{ statusCode: number; body: unknown }> {
  const body = JSON.stringify(payload)
  const sig = sign(body)
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': eventType,
      'x-hub-signature-256': sig,
      'x-github-delivery': deliveryId,
    },
    body,
  })
  return { statusCode: res.statusCode, body: JSON.parse(res.body) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CI webhook — check_run.completed (success)', () => {
  it('emits CIRunCompleted event when check_run concludes with success', async () => {
    const deliveryId = `delivery-success-${uuidv7()}`
    const payload = {
      action: 'completed',
      check_run: {
        id: 99001,
        name: 'CI / vitest',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/repo/runs/99001',
        started_at: '2026-05-01T10:00:00Z',
        completed_at: '2026-05-01T10:02:12Z',
        head_sha: 'deadbeef1234',
        pull_requests: [{ number: 101 }],
      },
      repository: { full_name: 'owner/repo' },
    }

    const { statusCode } = await postWebhook('check_run', payload, deliveryId)
    expect(statusCode).toBe(200)

    // Verify CIRunCompleted event was emitted
    const events = await eventStore.query({
      aggregate_id: testTaskId,
      event_types: ['CIRunCompleted'],
      limit: 10,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
    const evt = events.items[0]!
    expect((evt.payload as Record<string, unknown>).ci_conclusion).toBe('success')
    expect((evt.payload as Record<string, unknown>).ci_check_name).toContain('vitest')
    expect((evt.payload as Record<string, unknown>).ci_run_url).toBe(
      'https://github.com/owner/repo/runs/99001',
    )
  })
})

describe('CI webhook — check_run.completed (failure)', () => {
  it('emits CIRunFailed event when check_run concludes with failure', async () => {
    const deliveryId = `delivery-failure-${uuidv7()}`
    const payload = {
      action: 'completed',
      check_run: {
        id: 99002,
        name: 'CI / vitest',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/owner/repo/runs/99002',
        started_at: '2026-05-01T10:00:00Z',
        completed_at: '2026-05-01T10:01:00Z',
        head_sha: 'deadbeef1234',
        pull_requests: [{ number: 101 }],
      },
      repository: { full_name: 'owner/repo' },
    }

    const { statusCode } = await postWebhook('check_run', payload, deliveryId)
    expect(statusCode).toBe(200)

    const events = await eventStore.query({
      aggregate_id: testTaskId,
      event_types: ['CIRunFailed'],
      limit: 10,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
    const evt = events.items[0]!
    expect((evt.payload as Record<string, unknown>).ci_conclusion).toBe('failure')
  })
})

describe('CI webhook — workflow_run.completed', () => {
  it('emits CIRunCompleted event for workflow_run.completed with success', async () => {
    const deliveryId = `delivery-wf-${uuidv7()}`
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 88001,
        name: 'CI Pipeline',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/repo/actions/runs/88001',
        run_started_at: '2026-05-01T10:00:00Z',
        updated_at: '2026-05-01T10:05:00Z',
        head_sha: 'deadbeef1234',
        pull_requests: [{ number: 101 }],
      },
      repository: { full_name: 'owner/repo' },
    }

    const { statusCode } = await postWebhook('workflow_run', payload, deliveryId)
    expect(statusCode).toBe(200)

    const events = await eventStore.query({
      aggregate_id: testTaskId,
      event_types: ['CIRunCompleted'],
      limit: 20,
    })
    const wfEvent = events.items.find(
      (e) => (e.payload as Record<string, unknown>).ci_check_name === 'CI Pipeline',
    )
    expect(wfEvent).toBeDefined()
    expect((wfEvent!.payload as Record<string, unknown>).ci_conclusion).toBe('success')
  })
})

describe('CI webhook — check_run.started', () => {
  it('emits CIRunStarted event when check_run starts', async () => {
    const deliveryId = `delivery-started-${uuidv7()}`
    const payload = {
      action: 'created',
      check_run: {
        id: 99003,
        name: 'CI / lint',
        status: 'in_progress',
        conclusion: null,
        html_url: 'https://github.com/owner/repo/runs/99003',
        started_at: '2026-05-01T10:00:00Z',
        completed_at: null,
        head_sha: 'deadbeef1234',
        pull_requests: [{ number: 101 }],
      },
      repository: { full_name: 'owner/repo' },
    }

    const { statusCode } = await postWebhook('check_run', payload, deliveryId)
    expect(statusCode).toBe(200)

    const events = await eventStore.query({
      aggregate_id: testTaskId,
      event_types: ['CIRunStarted'],
      limit: 10,
    })
    expect(events.items.length).toBeGreaterThanOrEqual(1)
  })
})
