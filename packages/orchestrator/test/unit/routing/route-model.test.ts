/**
 * Unit tests for RoutingEngine.routeModel() — multi-provider routing and
 * cross-family SoD enforcement.
 *
 * Per Round 6 #8 spec AC #5: routing for reviewer where author was Opus must
 * NOT return Opus — parameterized routing test.
 */

import { describe, it, expect, vi } from 'vitest'
import { DefaultRoutingEngine, buildDefaultCatalog } from '../../../src/routing/engine.js'
import { BUILT_IN_DEFAULT_POLICY } from '../../../src/routing/policy.js'
import type { EventStore } from '../../../src/events/store.js'
import type { DB } from '../../../src/db/client.js'

// ---------------------------------------------------------------------------
// Minimal stubs (no real DB / EventStore needed for routeModel tests)
// ---------------------------------------------------------------------------

function makeStubEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({ eventId: 'stub-event-id' }),
    query: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    queryOne: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
  } as unknown as EventStore
}

function makeStubDb(): DB {
  const mockTx = { insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }) }
  return {
    transaction: vi.fn().mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => {
      await fn(mockTx)
    }),
  } as unknown as DB
}

function makeEngine() {
  return new DefaultRoutingEngine(
    makeStubDb(),
    makeStubEventStore(),
    BUILT_IN_DEFAULT_POLICY,
    buildDefaultCatalog(),
    1,
  )
}

// ---------------------------------------------------------------------------
// Tests — default routing matrix
// ---------------------------------------------------------------------------

describe('routeModel() — default routing matrix', () => {
  it('routes sr-dev:M to anthropic/claude-sonnet-4-6', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({ persona: 'sr-dev', estimate: 'M' })
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.sodApplied).toBe(false)
  })

  it('routes jr-dev:S to anthropic/claude-haiku-4-5', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({ persona: 'jr-dev', estimate: 'S' })
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-haiku-4-5')
  })

  it('routes principal-dev:L to anthropic/claude-opus-4-7', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({ persona: 'principal-dev', estimate: 'L' })
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-opus-4-7')
  })

  it('routes reviewer:M to anthropic/claude-sonnet-4-6', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({ persona: 'reviewer', estimate: 'M' })
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.sodApplied).toBe(false)
  })

  it('falls back to sonnet for unknown persona', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({ persona: 'unknown-persona', estimate: 'M' })
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('emits ModelRoutingDecided event', async () => {
    const eventStore = makeStubEventStore()
    const engine = new DefaultRoutingEngine(
      makeStubDb(),
      eventStore,
      BUILT_IN_DEFAULT_POLICY,
      buildDefaultCatalog(),
      1,
    )

    await engine.routeModel({ persona: 'sr-dev', estimate: 'M', traceId: 'trace-123' })

    expect(eventStore.append).toHaveBeenCalledOnce()
    const call = (eventStore.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.event_type).toBe('ModelRoutingDecided')
    expect(call.payload.provider).toBe('anthropic')
    expect(call.payload.model).toBe('claude-sonnet-4-6')
  })
})

// ---------------------------------------------------------------------------
// Tests — cross-family SoD rule (AC #5)
// ---------------------------------------------------------------------------

describe('routeModel() — cross-family SoD rule', () => {
  const OPUS_MODELS = [
    'claude-opus-4-6',
    'claude-opus-4-7',
    'anthropic.claude-3-opus-20240229-v1:0',
  ]

  for (const authorModel of OPUS_MODELS) {
    it(`reviewer routes to non-Opus when author used ${authorModel}`, async () => {
      const engine = makeEngine()
      const result = await engine.routeModel({
        persona: 'reviewer',
        estimate: 'L',
        authorProvider: 'anthropic',
        authorModel,
      })

      // Must NOT be an Opus-family model
      expect(result.model).not.toMatch(/opus/i)
      expect(result.sodApplied).toBe(true)
      expect(result.reason).toMatch(/SoD/i)
    })
  }

  it('reviewer can still use Opus when author used Haiku', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'L',
      authorProvider: 'anthropic',
      authorModel: 'claude-haiku-4-5',
    })

    // No SoD override needed — author was not Opus
    expect(result.sodApplied).toBe(false)
    // reviewer:L defaults to opus-4-7
    expect(result.model).toBe('claude-opus-4-7')
  })

  it('SoD rule only applies to reviewer persona, not sr-dev', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'sr-dev',
      estimate: 'L',
      authorProvider: 'anthropic',
      authorModel: 'claude-opus-4-7',
    })

    // sr-dev:L → sonnet; SoD doesn't affect non-reviewer
    expect(result.sodApplied).toBe(false)
  })

  it('reviewer without authorModel has no SoD applied', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'L',
    })

    expect(result.sodApplied).toBe(false)
  })
})
