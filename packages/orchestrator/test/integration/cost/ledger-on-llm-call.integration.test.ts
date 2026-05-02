/**
 * Integration test: cost ledger written on LLM call — AC #7
 *
 * Scenario: FallbackDriver.send() → cost_ledger row written.
 * Uses a real Postgres DB and a stubbed HTTP boundary (fake provider).
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createCostService } from '../../../src/cost/service.js'
import { FallbackDriver } from '../../../src/drivers/fallback.js'
import type { LLMDriver, LLMRequest, LLMResponse, ProviderHealth } from '../../../src/drivers/types.js'
import { costLedger } from '../../../src/db/schema/cost.js'
import { events } from '../../../src/db/schema/events.js'

let installId: string
let eventStore: ReturnType<typeof createEventStore>

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(() => {
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeProvider(model: string, inputTokens: number, outputTokens: number): LLMDriver {
  return {
    providerId: 'fake-anthropic',
    availableModels: [model],
    async send(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: [{ type: 'text', text: 'test response' }],
        usage: {
          input_tokens:  inputTokens,
          output_tokens: outputTokens,
          cache_read:    0,
          cache_write:   0,
        },
      }
    },
    async health(): Promise<ProviderHealth> {
      return { healthy: true, providerId: 'fake-anthropic', lastCheckedAt: new Date().toISOString() }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — AC #7
// ---------------------------------------------------------------------------

describe('cost ledger on LLM call — AC #7', () => {
  it('writes a cost_ledger row after a successful FallbackDriver.send()', async () => {
    const projectId = uuidv7()
    const model     = 'claude-sonnet-4-6'

    const costService = createCostService(db, eventStore, installId)

    // Create FallbackDriver with a cost context wired.
    const fakeProvider = makeFakeProvider(model, 100_000, 50_000)
    const driver = new FallbackDriver([fakeProvider])
    driver.setCostContext({ costService, projectId })

    const req: LLMRequest = {
      model,
      messages: [{ role: 'user', content: 'hello' }],
    }

    await driver.send(req)

    // Allow async fire-and-forget to settle (the _appendCostLedger is awaited
    // inside the driver but the void call in the test means we may need a tick).
    await new Promise((r) => setTimeout(r, 100))

    // Assert: at least one cost_ledger row for this project.
    const rows = await db
      .select()
      .from(costLedger)
      .where(eq(costLedger.projectId, projectId))
      .limit(10)

    expect(rows.length).toBeGreaterThanOrEqual(1)

    const row = rows[0]!
    expect(row.model).toBe(model)
    expect(row.provider).toBe('fake-anthropic')
    expect(row.inputTokens).toBe(100_000)
    expect(row.outputTokens).toBe(50_000)

    // Cost should be: 100k * $3/1M + 50k * $15/1M = $0.30 + $0.75 = $1.05
    const costUsd = Number(row.costUsd)
    expect(costUsd).toBeCloseTo(1.05, 4)
  })

  it('does not write a ledger row when no cost context is set', async () => {
    const projectId = uuidv7()
    const model     = 'claude-sonnet-4-6'

    // Create driver WITHOUT cost context.
    const fakeProvider = makeFakeProvider(model, 100_000, 50_000)
    const driver = new FallbackDriver([fakeProvider])
    // No setCostContext() call.

    const req: LLMRequest = {
      model,
      messages: [{ role: 'user', content: 'hello' }],
    }

    await driver.send(req)
    await new Promise((r) => setTimeout(r, 100))

    const rows = await db
      .select()
      .from(costLedger)
      .where(eq(costLedger.projectId, projectId))
      .limit(10)

    // No rows for this specific projectId since no context was set.
    expect(rows.length).toBe(0)
  })

  it('CostLedgerAppended event is emitted after append', async () => {
    const projectId = uuidv7()
    const model     = 'claude-sonnet-4-6'

    const costService = createCostService(db, eventStore, installId)

    const fakeProvider = makeFakeProvider(model, 1_000_000, 1_000_000)
    const driver = new FallbackDriver([fakeProvider])
    driver.setCostContext({ costService, projectId })

    await driver.send({ model, messages: [{ role: 'user', content: 'test' }] })
    // Allow fire-and-forget ledger append to complete.
    await new Promise((r) => setTimeout(r, 150))

    // Query the events table directly (LISTEN/NOTIFY is not reliable in tests).
    const appendedEvents = await db
      .select()
      .from(events)
      .where(
        eq(events.aggregateId, projectId),
      )
      .limit(10)

    const costEvents = appendedEvents.filter((e) => e.eventType === 'CostLedgerAppended')
    expect(costEvents.length).toBeGreaterThanOrEqual(1)

    const p = costEvents[0]!.payload as Record<string, unknown>
    expect(p['project_id']).toBe(projectId)
    // AC-6 sanity: 1M+1M at Sonnet = $18.00
    expect(Number(p['cost_usd'])).toBeCloseTo(18.00, 2)
  })
})
