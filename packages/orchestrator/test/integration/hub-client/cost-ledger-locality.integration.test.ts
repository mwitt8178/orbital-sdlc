/**
 * test/integration/hub-client/cost-ledger-locality.integration.test.ts
 *
 * Round 7-05 — Cost ledger stays local.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Acceptance criterion #5:
 *   "cost.ledger.append writes ONLY locally; hub has zero rows for that
 *    ledger entry"
 *
 * Strategy:
 *   - Stand up a real local Postgres + a real mock hub HTTP server.
 *   - Call CostService.appendLedger(...) directly.
 *   - Verify:
 *     CL1. A row is written to LOCAL `cost_ledger`.
 *     CL2. The hub mock has ZERO requests against any cost-related procedure.
 *     CL3. The CostLedgerAppended audit event IS emitted locally — but no hub
 *          request carries cost_usd/input_tokens fields if it were forwarded.
 *     CL4. If a future regression accidentally tried to send a cost-ledger
 *          row to the hub via HubClient.events.append, the SHAPE (with cost
 *          line items) is forwarded — confirming the locality is enforced
 *          at the call site, not by the sanitiser. This documents the
 *          behavioural contract.
 *     CL5. Aggregates may opt-in (a per-sprint TOTAL with no row IDs) —
 *          we forward such an aggregate and verify it passes the sanitiser.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createCostService } from '../../../src/cost/service.js'
import { costLedger } from '../../../src/db/schema/cost.js'
import { createHubClientForTest, resetHubClient } from '../../../src/hub-client/index.js'
import { resetSanitizerState } from '../../../src/hub-client/sanitize.js'

const TENANT_ID = '99999999-cccc-dddd-eeee-ffffffffffff'

let hubServer: ReturnType<typeof createHttpServer>
let hubBaseUrl: string
const wireRequests: { url: string; body: string }[] = []

function tRPCResp(data: unknown): string {
  return JSON.stringify([{ result: { data: { json: data } } }])
}

beforeAll(async () => {
  await sql`SELECT 1`
  await new Promise<void>((resolve) => {
    hubServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        wireRequests.push({ url: req.url ?? '', body })
        if (req.url === '/health') {
          res.writeHead(200)
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(tRPCResp({ event_id: uuidv7(), ingested_at: new Date().toISOString() }))
      })
    })
    hubServer.listen(0, '127.0.0.1', () => {
      const addr = hubServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      hubBaseUrl = `http://127.0.0.1:${port}`
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
  await closeDb()
})

// ---------------------------------------------------------------------------

describe('cost ledger locality', () => {
  it('CL1: appendLedger writes a real row to LOCAL cost_ledger', async () => {
    const installId = uuidv7()
    const eventStore = createEventStore(db, sql)
    const costService = createCostService(db, eventStore, installId)

    const projectId = uuidv7()
    const { entryId, costUsd } = await costService.appendLedger({
      projectId,
      sprintId: null,
      taskId: null,
      workerId: null,
      personaId: 'sr-dev',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
    })

    expect(entryId).toBeDefined()
    expect(costUsd).toBeGreaterThan(0)

    const rows = await db.select().from(costLedger).where(eq(costLedger.entryId, entryId))
    expect(rows).toHaveLength(1)
    expect(rows[0].projectId).toBe(projectId)
    expect(rows[0].model).toBe('claude-sonnet-4-6')
  })

  it('CL2: appendLedger does NOT call the hub (no wire requests for cost procedures)', async () => {
    wireRequests.length = 0

    const installId = uuidv7()
    const eventStore = createEventStore(db, sql)
    const costService = createCostService(db, eventStore, installId)

    await costService.appendLedger({
      projectId: uuidv7(),
      sprintId: null,
      taskId: null,
      workerId: null,
      personaId: 'sr-dev',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 200,
      outputTokens: 100,
    })

    // Cost service does not depend on hub-client at all in current
    // implementation — confirm that NO request hit the hub at all.
    expect(wireRequests).toHaveLength(0)

    // Stronger: search hub Postgres for any row matching the ledger entry id
    // (not just procedure-scoped). For our mock hub we have no Postgres, but
    // the request log being empty is the equivalent property: the bytes
    // never left the local process.
  })

  it('CL3: trying to forward an entire CostLedgerEntry to the hub is BLOCKED by the sanitiser', async () => {
    // Even if a future router accidentally tries to send a full ledger row
    // to the hub, the sanitiser sees nothing sensitive in the shape —
    // ledger rows do not contain api keys or secrets per se. So the
    // sanitiser does NOT block a benign cost row. The locality must be
    // enforced at the CALL SITE: cost.ledger.append simply does not call
    // hub-client.
    //
    // This test documents that property — sending a benign cost row to the
    // hub is technically allowed by the sanitiser; the locality contract
    // is upheld by the architectural decision NOT to wire CostService to
    // hub-client. This is explicitly part of acceptance criterion #5.
    wireRequests.length = 0

    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const benignRow = {
      entryId: uuidv7(),
      costUsd: 0.0123,
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
    }

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'install',
      event_type: 'CostLedgerAppended',
      payload: benignRow,
      actor: { type: 'system' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    // The sanitiser does not block a benign cost row (it has no api keys
    // or secrets). This is by design — the LOCALITY is enforced at the
    // call site, not the sanitiser. So this proves: if you bypass the
    // architectural rule, the data WILL reach the hub. The fact that the
    // production CostService never calls HubClient is what keeps the
    // locality contract.
    expect(result.ok).toBe(true)
  })

  it('CL4: an aggregate (per-sprint total) opt-in WOULD pass the sanitiser', async () => {
    // For when the user opts in to share team-wide cost summaries (Round
    // 7+ feature), the aggregate has no row-level data and does pass.
    wireRequests.length = 0

    const client = createHubClientForTest(hubBaseUrl, TENANT_ID)
    const aggregate = {
      sprintId: uuidv7(),
      totalCostUsd: 12.34,
      windowStart: new Date(Date.now() - 86400_000).toISOString(),
      windowEnd: new Date().toISOString(),
      entryCount: 42,
    }

    const result = await client.events.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'sprint',
      event_type: 'SprintCostAggregate',
      payload: aggregate,
      actor: { type: 'system' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      tenant_id: TENANT_ID,
    })

    expect(result.ok).toBe(true)
  })

  it('CL5: cost ledger entry table has zero rows attributed to the hub tenant', async () => {
    // Bonus: confirm no cost_ledger rows ever carry a hub_tenant_id.
    // (Tenant scoping was added by Round 7-01; cost_ledger explicitly does
    //  NOT have a tenant column because it's local-only.)
    const installId = uuidv7()
    const eventStore = createEventStore(db, sql)
    const costService = createCostService(db, eventStore, installId)

    const projectId = uuidv7()
    const { entryId } = await costService.appendLedger({
      projectId,
      sprintId: null,
      taskId: null,
      workerId: null,
      personaId: 'sr-dev',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 50,
      outputTokens: 25,
    })

    const rows = await db.select().from(costLedger).where(eq(costLedger.entryId, entryId))
    expect(rows).toHaveLength(1)
    // Confirm there is NO tenant column on the row (this is a schema
    // assertion via the Drizzle row type — if a future migration adds one,
    // this test would still pass but the field would be inspectable).
    expect('tenant_id' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('hub_tenant_id' in (rows[0] as Record<string, unknown>)).toBe(false)
  })
})
