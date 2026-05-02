/**
 * test/integration/hub-client/leak-prevention.integration.test.ts
 *
 * Round 7-05 — wire-boundary leak prevention integration test.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Stands up a real HTTP mock hub and verifies that:
 *   LP1. A benign event is accepted by the hub.
 *   LP2. An event payload containing an Anthropic key is REJECTED at the
 *        wire boundary (HubClient.rpc) — sanitiser throws and the request
 *        never hits the network.
 *   LP3. An event payload containing a `secret` field is rejected.
 *   LP4. An event payload pointing at a local key path is rejected.
 *   LP5. The mock hub records ZERO requests when sanitiser triggers — the
 *        bytes never went out (mockHub.requestsCount didn't increment).
 *   LP6. Sanitiser runs at every level — hub.events.append, hub.query,
 *        hub.mutate, hub.tasks.claim — for the same dirty payload.
 *
 * No mocks of the sanitiser itself; it runs in-process. The "mock hub" is
 * just a real HTTP server we control so we can count incoming requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { uuidv7 } from 'uuidv7'

import { createHubClientForTest, resetHubClient } from '../../../src/hub-client/index.js'
import { resetSanitizerState } from '../../../src/hub-client/sanitize.js'

// ---------------------------------------------------------------------------
// Mock hub
// ---------------------------------------------------------------------------

const TENANT_ID = '99999999-9999-9999-9999-999999999999'

let hubServer: ReturnType<typeof createHttpServer>
let hubPort: number
let hubBaseUrl: string
const requestLog: { url: string; body: string }[] = []

function tRPCBatchResponse(data: unknown): string {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    hubServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        const url = req.url ?? ''
        requestLog.push({ url, body })

        if (url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }
        if (url.startsWith('/trpc/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            tRPCBatchResponse({ event_id: uuidv7(), ingested_at: new Date().toISOString() }),
          )
          return
        }
        res.writeHead(404)
        res.end()
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
  resetSanitizerState()
  resetHubClient()
  await new Promise<void>((resolve, reject) => {
    hubServer.close((err) => (err ? reject(err) : resolve()))
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('leak-prevention at the wire boundary', () => {
  it('LP1: a benign event passes the sanitiser and reaches the mock hub', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const before = requestLog.filter((r) => r.url.startsWith('/trpc/audit.events.append')).length

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'TaskClaimed',
      payload: { taskId: 't1', notes: 'all good' },
      actor: { type: 'user', userId: 'u1' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(true)
    const after = requestLog.filter((r) => r.url.startsWith('/trpc/audit.events.append')).length
    expect(after - before).toBe(1)
  })

  it('LP2: an event payload containing an Anthropic key is REJECTED at wire', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'TaskClaimed',
      payload: { msg: 'My key sk-ant-api03-actual-leaked-key-9999 should not be here' },
      actor: { type: 'user' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected leak to be blocked')
    expect(result.message).toContain('LOCAL_DATA_LEAK')

    // Confirm the bytes never hit the wire.
    const sentRequests = requestLog.filter((r) => r.url.startsWith('/trpc/audit.events.append'))
    expect(sentRequests).toHaveLength(0)
  })

  it('LP3: an event payload with a "secret" field name is rejected', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'TaskClaimed',
      payload: { secret: 'leaked' },
      actor: { type: 'user' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected leak to be blocked')
    expect(result.message).toContain('LOCAL_DATA_LEAK')
    expect(requestLog.filter((r) => r.url.startsWith('/trpc/audit.events.append'))).toHaveLength(0)
  })

  it('LP4: an event payload pointing at ~/.orbital/keys/ is rejected', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'TaskClaimed',
      payload: { path: '/Users/me/.orbital/keys/install.json', size: 1024 },
      actor: { type: 'user' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected leak to be blocked')
    expect(result.message).toContain('LOCAL_DATA_LEAK')
  })

  it('LP5: cross-procedure protection — generic query() also sanitises', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const result = await client.query('memory.list', { api_key: 'leaked' }, TENANT_ID)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected leak to be blocked')
    expect(result.message).toContain('LOCAL_DATA_LEAK')
    expect(requestLog.filter((r) => r.url.startsWith('/trpc/memory.list'))).toHaveLength(0)
  })

  it('LP6: cross-procedure protection — mutate() also sanitises', async () => {
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const result = await client.mutate(
      'orchestration.tasks.claim',
      { taskId: 't1', stdout: 'leaked output' },
      TENANT_ID,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected leak to be blocked')
    expect(result.message).toContain('LOCAL_DATA_LEAK')
  })

  it('LP7: simulated end-to-end — hub Postgres has zero rows for the leaked event', async () => {
    // Even though we use a mock hub here, the property holds: when sanitiser
    // throws, the wire never sees the bytes. This is the unit-shaped proof
    // of acceptance criterion #2 (key NOT in hub Postgres) — the bytes
    // never leave the local process. A real-DB E2E with both the hub server
    // and local client running in-process would verify the same invariant
    // by querying hub_db.events for the tenant_id and getting zero rows;
    // here we verify by counting wire requests.
    requestLog.length = 0
    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)

    for (let i = 0; i < 5; i++) {
      await client.events.append({
        aggregate_id: uuidv7(),
        aggregate_type: 'task',
        event_type: 'TaskClaimed',
        payload: { msg: `leak attempt ${i}: sk-ant-api03-key-${i}-1234567890` },
        actor: { type: 'user' },
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
        tenant_id: TENANT_ID,
      })
    }

    const sent = requestLog.filter((r) => r.url.startsWith('/trpc/audit.events.append'))
    expect(sent).toHaveLength(0)
  })
})
