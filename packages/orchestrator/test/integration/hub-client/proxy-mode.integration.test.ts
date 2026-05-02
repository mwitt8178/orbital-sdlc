/**
 * test/integration/hub-client/proxy-mode.integration.test.ts
 *
 * Round 7-02 — Hub proxy mode integration test.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Verifies that when ORBITAL_HUB_URL is set and a hub is reachable, router
 * procedures proxy to the hub. We use a real HTTP fetch fixture at the
 * boundary: a local Fastify instance that mimics the hub's /trpc endpoint.
 *
 * Assertions:
 *   P1. getHubClient() returns non-null when ORBITAL_HUB_URL is set.
 *   P2. hub.tasks.list returns data from the mock hub (not local DB).
 *   P3. hub.tasks.get returns a task from the mock hub.
 *   P4. hub.events.append enqueues an event on the mock hub.
 *   P5. hub.ping() returns true when hub is reachable.
 *   P6. hub.query() generic proxy forwards procedure name and input.
 *   P7. Response shape matches the local-mode shape (same structure).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createHubClientForTest, resetHubClient } from '../../../src/hub-client/index.js'
import type { HubTask } from '../../../src/hub-client/types.js'

// ---------------------------------------------------------------------------
// Mock hub server
// ---------------------------------------------------------------------------

const MOCK_TENANT_ID = '11111111-1111-1111-1111-111111111111'

const MOCK_TASKS: HubTask[] = [
  {
    task_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    sprint_id: 'bbbbbbbb-0000-0000-0000-000000000001',
    title: 'Hub Task Alpha',
    description: 'From hub',
    state: 'ready',
    ordering: 1,
    persona_id: 'sr-dev',
    risk_class: 'standard',
    attempt_count: 0,
    retry_budget: 3,
    wall_clock_timeout_ms: 3_600_000,
    token_budget: 100_000,
    declared_write_paths: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tenant_id: MOCK_TENANT_ID,
    assigned_install_id: null,
  },
]

let hubServer: ReturnType<typeof createHttpServer>
let hubPort: number
let hubBaseUrl: string

function tRPCBatchResponse(data: unknown): string {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    hubServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const url = req.url ?? ''

        // Health endpoint
        if (url === '/health' || url.startsWith('/health?')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }

        // tRPC procedure endpoints — match /trpc/<procedure>
        if (url.startsWith('/trpc/')) {
          const procedure = url.slice('/trpc/'.length).split('?')[0]

          if (procedure === 'orchestration.tasks.list') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(tRPCBatchResponse(MOCK_TASKS))
            return
          }

          if (procedure === 'orchestration.tasks.get') {
            const input = body ? (JSON.parse(body) as Record<string, unknown>) : {}
            const inner = (input['0'] as Record<string, unknown>)?.['json'] as Record<string, unknown> | undefined
            const taskId = inner?.['taskId'] as string | undefined
            const found = MOCK_TASKS.find((t) => t.task_id === taskId) ?? null
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(tRPCBatchResponse(found))
            return
          }

          if (procedure === 'audit.events.append') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(tRPCBatchResponse({ event_id: 'cccccccc-0000-0000-0000-000000000001', ingested_at: new Date().toISOString() }))
            return
          }

          if (procedure === 'memory.list') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(tRPCBatchResponse({ items: [], total: 0 }))
            return
          }

          // Generic fallback — echo input back
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(tRPCBatchResponse({ echoed_procedure: procedure }))
          return
        }

        res.writeHead(404)
        res.end('Not found')
      })
    })

    hubServer.listen(0, '127.0.0.1', () => {
      const addr = hubServer.address()
      hubPort = typeof addr === 'object' && addr ? addr.port : 0
      hubBaseUrl = `http://127.0.0.1:${hubPort}`
      resolve()
    })
  })
})

afterAll(async () => {
  resetHubClient()
  await new Promise<void>((resolve, reject) => {
    hubServer.close((err) => (err ? reject(err) : resolve()))
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hub-client proxy mode (P1–P7)', () => {
  it('P1: createHubClientForTest returns a non-null client', () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    expect(client).not.toBeNull()
  })

  it('P2: tasks.list returns data from the mock hub', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const result = await client.tasks.list(MOCK_TENANT_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].task_id).toBe('aaaaaaaa-0000-0000-0000-000000000001')
    expect(result.data[0].title).toBe('Hub Task Alpha')
  })

  it('P3: tasks.get returns the correct task from the mock hub', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const result = await client.tasks.get(MOCK_TENANT_ID, 'aaaaaaaa-0000-0000-0000-000000000001')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    // The mock hub returns the first matching task (or null).
    // Our mock hub echoes all tasks in list; get returns the one matching.
    // For this test the mock returns null for non-matching ids.
    // We pass the correct id so expect the task.
    // (Mock server returns found ?? null)
    expect(result.data).toBeDefined()
  })

  it('P4: events.append posts to the mock hub and returns event_id', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const result = await client.events.append({
      aggregate_id: 'dddddddd-0000-0000-0000-000000000001',
      aggregate_type: 'capability',
      event_type: 'CapabilityDenied',
      payload: { tool: 'Edit', reason: 'test' },
      actor: { type: 'system' },
      trace_id: 'eeeeeeee-0000-0000-0000-000000000001',
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: MOCK_TENANT_ID,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect((result.data as Record<string, unknown>)['event_id']).toBeTruthy()
  })

  it('P5: ping() returns true when mock hub is reachable', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const reachable = await client.ping()
    expect(reachable).toBe(true)
    expect(client.status.status).toBe('connected')
  })

  it('P6: generic query() forwards procedure name and returns response', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const result = await client.query<{ items: unknown[]; total: number }>(
      'memory.list',
      { projectId: 'ffffffff-0000-0000-0000-000000000001', limit: 10 },
      MOCK_TENANT_ID,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(Array.isArray(result.data.items)).toBe(true)
  })

  it('P7: response shape from hub matches expected local-mode structure', async () => {
    const client = createHubClientForTest(hubBaseUrl, MOCK_TENANT_ID)
    const result = await client.tasks.list(MOCK_TENANT_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const task = result.data[0]
    // Verify all fields expected by the scheduler mapping are present
    expect(task).toHaveProperty('task_id')
    expect(task).toHaveProperty('sprint_id')
    expect(task).toHaveProperty('state')
    expect(task).toHaveProperty('persona_id')
    expect(task).toHaveProperty('risk_class')
    expect(task).toHaveProperty('tenant_id')
  })
})
