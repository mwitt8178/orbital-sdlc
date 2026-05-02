/**
 * Unit tests for drivers/fallback.ts
 *
 * Tests: ordered fallback, circuit breaker open/close, event emission,
 * non-retriable error surfacing immediately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FallbackDriver, createFallbackDriver, type ProviderEventEmitter, type ProviderFallbackEvent } from '../../../src/drivers/fallback.js'
import { ProviderError } from '../../../src/drivers/types.js'
import type { LLMDriver, LLMRequest, LLMResponse, ProviderHealth } from '../../../src/drivers/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDriver(id: string, behavior: 'ok' | 'retriable' | 'fatal'): LLMDriver {
  return {
    providerId: id,
    availableModels: [`${id}-model`],
    send: vi.fn().mockImplementation(async () => {
      if (behavior === 'ok') {
        return {
          content: [{ type: 'text', text: `response from ${id}` }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } satisfies LLMResponse
      }
      if (behavior === 'retriable') {
        throw new ProviderError(id, true, 503, `${id} service unavailable`)
      }
      throw new ProviderError(id, false, 400, `${id} bad request`)
    }),
    health: vi.fn().mockResolvedValue({ healthy: true, providerId: id, lastCheckedAt: new Date().toISOString() } satisfies ProviderHealth),
  }
}

function makeEmitter(): { emitter: ProviderEventEmitter; events: ProviderFallbackEvent[] } {
  const events: ProviderFallbackEvent[] = []
  const emitter: ProviderEventEmitter = {
    emit: (e) => { events.push(e) },
  }
  return { emitter, events }
}

const REQ: LLMRequest = {
  model: 'some-model',
  messages: [{ role: 'user', content: 'test' }],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FallbackDriver — basic fallback', () => {
  it('returns response from first healthy provider', async () => {
    const a = makeDriver('provA', 'ok')
    const b = makeDriver('provB', 'ok')
    const driver = createFallbackDriver([a, b])

    const result = await driver.send(REQ)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'response from provA' })
    expect(a.send).toHaveBeenCalledOnce()
    expect(b.send).not.toHaveBeenCalled()
  })

  it('falls through to second provider when first throws retriable error', async () => {
    const a = makeDriver('provA', 'retriable')
    const b = makeDriver('provB', 'ok')
    const { emitter, events } = makeEmitter()
    const driver = createFallbackDriver([a, b], emitter)

    const result = await driver.send(REQ)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'response from provB' })
    expect(a.send).toHaveBeenCalledOnce()
    expect(b.send).toHaveBeenCalledOnce()

    // Events: failed + succeeded
    expect(events.some((e) => e.type === 'ProviderCallFailed' && e.providerId === 'provA')).toBe(true)
    expect(events.some((e) => e.type === 'ProviderCallSucceeded' && e.providerId === 'provB')).toBe(true)
  })

  it('surfaces non-retriable error immediately without trying next provider', async () => {
    const a = makeDriver('provA', 'fatal')
    const b = makeDriver('provB', 'ok')
    const driver = createFallbackDriver([a, b])

    await expect(driver.send(REQ)).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderError && e.retriable === false,
    )
    expect(b.send).not.toHaveBeenCalled()
  })

  it('throws last error when all providers fail', async () => {
    const a = makeDriver('provA', 'retriable')
    const b = makeDriver('provB', 'retriable')
    const driver = createFallbackDriver([a, b])

    await expect(driver.send(REQ)).rejects.toBeInstanceOf(ProviderError)
  })

  it('requires at least one provider', () => {
    expect(() => createFallbackDriver([])).toThrow('at least one provider')
  })
})

describe('FallbackDriver — circuit breaker', () => {
  it('opens circuit after 5 consecutive failures and emits ProviderCircuitOpened', async () => {
    const { emitter, events } = makeEmitter()
    const bad = makeDriver('provA', 'retriable')
    const good = makeDriver('provB', 'ok')
    const driver = createFallbackDriver([bad, good], emitter)

    // 5 calls to exhaust threshold
    for (let i = 0; i < 5; i++) {
      await driver.send(REQ)
    }

    const circuitOpened = events.filter((e) => e.type === 'ProviderCircuitOpened')
    expect(circuitOpened.length).toBeGreaterThanOrEqual(1)
    if (circuitOpened[0]?.type === 'ProviderCircuitOpened') {
      expect(circuitOpened[0].providerId).toBe('provA')
      expect(circuitOpened[0].consecutiveFailures).toBeGreaterThanOrEqual(5)
    }
  })

  it('skips open-circuit provider on subsequent calls', async () => {
    const { emitter } = makeEmitter()
    const bad = makeDriver('provA', 'retriable')
    const good = makeDriver('provB', 'ok')
    const driver = createFallbackDriver([bad, good], emitter)

    // Trigger circuit open
    for (let i = 0; i < 5; i++) {
      await driver.send(REQ)
    }

    // Reset call counts
    vi.clearAllMocks()

    // After circuit opens, provA should be skipped
    await driver.send(REQ)
    expect(bad.send).not.toHaveBeenCalled()
    expect(good.send).toHaveBeenCalledOnce()
  })

  it('closes circuit after successful probe and emits ProviderCircuitClosed', async () => {
    const { emitter, events } = makeEmitter()

    let callCount = 0
    const flaky: LLMDriver = {
      providerId: 'flaky',
      availableModels: ['flaky-model'],
      send: vi.fn().mockImplementation(async () => {
        callCount++
        // First 5 calls fail (trigger open), then all succeed (probe succeeds)
        if (callCount <= 5) throw new ProviderError('flaky', true, 503, 'down')
        return {
          content: [{ type: 'text', text: 'recovered' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } satisfies LLMResponse
      }),
      health: vi.fn().mockResolvedValue({ healthy: true, providerId: 'flaky', lastCheckedAt: new Date().toISOString() }),
    }

    const backup = makeDriver('backup', 'ok')
    const driver = createFallbackDriver([flaky, backup], emitter)

    // Trigger open
    for (let i = 0; i < 5; i++) await driver.send(REQ)

    // Directly manipulate the internal circuit to set nextProbeAt in the past
    // so the probe fires on the next call.
    const snapBefore = driver.getCircuitSnapshots()
    expect(snapBefore['flaky']?.state).toBe('open')

    // Hack: access private map to fast-forward the probe timer
    const internalCircuits = (driver as unknown as { _circuits: Map<string, { _nextProbeAt: number | null }> })._circuits
    const flakyCircuit = internalCircuits.get('flaky')
    if (flakyCircuit) flakyCircuit._nextProbeAt = Date.now() - 1

    // Probe call — flaky is half-open, call succeeds → closed
    const result = await driver.send(REQ)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'recovered' })

    const circuitClosed = events.filter((e) => e.type === 'ProviderCircuitClosed')
    expect(circuitClosed.length).toBeGreaterThanOrEqual(1)
  })

  it('exposes circuit snapshots via getCircuitSnapshots()', async () => {
    const a = makeDriver('provA', 'ok')
    const driver = createFallbackDriver([a])
    const snaps = driver.getCircuitSnapshots()
    expect(snaps).toHaveProperty('provA')
    expect(snaps['provA']?.state).toBe('closed')
  })
})
