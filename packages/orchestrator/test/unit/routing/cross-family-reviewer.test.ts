/**
 * Cross-family SoD tests for reviewer routing.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * AC #4: when author persona used Opus, routing engine MUST NOT route
 * reviewer to Opus. Parameterized across all Opus model IDs.
 */

import { describe, it, expect, vi } from 'vitest'
import { DefaultRoutingEngine, buildDefaultCatalog } from '../../../src/routing/engine.js'
import { BUILT_IN_DEFAULT_POLICY } from '../../../src/routing/policy.js'
import type { EventStore } from '../../../src/events/store.js'
import type { DB } from '../../../src/db/client.js'

// ---------------------------------------------------------------------------
// Stubs (no real DB / EventStore)
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
// Cross-family SoD rule tests (AC #4)
// ---------------------------------------------------------------------------

describe('cross-family reviewer SoD rule', () => {
  // All Opus-family model IDs the system may encounter
  const OPUS_AUTHOR_MODELS = [
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-3-opus-20240229-v1:0',
    'anthropic.claude-3-opus-20240229-v1:0',
  ] as const

  for (const authorModel of OPUS_AUTHOR_MODELS) {
    it(`reviewer MUST NOT use Opus when author used ${authorModel}`, async () => {
      const engine = makeEngine()
      const result = await engine.routeModel({
        persona: 'reviewer',
        estimate: 'L',
        authorProvider: 'anthropic',
        authorModel,
      })

      // The result model must not contain "opus" (case-insensitive)
      expect(result.model).not.toMatch(/opus/i)
      // SoD was applied
      expect(result.sodApplied).toBe(true)
      // Reason mentions SoD
      expect(result.reason).toMatch(/SoD/i)
      // Must be a viable model (not empty)
      expect(result.model.length).toBeGreaterThan(0)
      // Provider is still anthropic
      expect(result.provider).toBe('anthropic')
    })
  }

  it('reviewer may use Opus when author used Haiku (no SoD needed)', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'L',
      authorProvider: 'anthropic',
      authorModel: 'claude-haiku-4-5',
    })

    expect(result.sodApplied).toBe(false)
    // reviewer:L defaults to opus-4-7 — allowed here
    expect(result.model).toBe('claude-opus-4-7')
  })

  it('reviewer may use Opus when author used Sonnet (no SoD needed)', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'M',
      authorProvider: 'anthropic',
      authorModel: 'claude-sonnet-4-6',
    })

    expect(result.sodApplied).toBe(false)
    // reviewer:M defaults to sonnet
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('SoD rule only applies to reviewer, not other personas', async () => {
    const engine = makeEngine()

    // sr-dev with Opus author → no SoD
    const result = await engine.routeModel({
      persona: 'sr-dev',
      estimate: 'M',
      authorProvider: 'anthropic',
      authorModel: 'claude-opus-4-6',
    })
    expect(result.sodApplied).toBe(false)
  })

  it('reviewer without authorModel — no SoD applied', async () => {
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'L',
    })
    expect(result.sodApplied).toBe(false)
    // Default routing still works
    expect(result.model).toBe('claude-opus-4-7')
  })

  it('SoD fallback is Sonnet, not Haiku', async () => {
    // Reviewer downgraded from Opus → should land on Sonnet, not Haiku
    // (Sonnet is the right capability tier for meaningful code review)
    const engine = makeEngine()
    const result = await engine.routeModel({
      persona: 'reviewer',
      estimate: 'L',
      authorModel: 'claude-opus-4-6',
    })
    expect(result.model).toBe('claude-sonnet-4-6')
  })
})
