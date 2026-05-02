/**
 * graceful-drain.test.ts — Unit tests for DrainController.
 *
 * Gap O4: Graceful HTTP drain on shutdown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDrainController } from '../../../src/middleware/graceful-drain.js'
import type { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Fake Fastify instance that captures hook registrations and lets us invoke them.
// ---------------------------------------------------------------------------

interface HookHandler {
  (req: unknown, reply: unknown, done: () => void): void
}

interface ErrorHookHandler {
  (req: unknown, reply: unknown, err: unknown, done: () => void): void
}

function makeFakeFastify(): FastifyInstance & {
  _fire(event: 'onRequest' | 'onResponse'): void
  _fireError(): void
} {
  const hooks: Record<string, HookHandler | ErrorHookHandler> = {}

  const app = {
    addHook: vi.fn((event: string, handler: HookHandler | ErrorHookHandler) => {
      hooks[event] = handler
    }),
    _fire(event: 'onRequest' | 'onResponse') {
      const handler = hooks[event] as HookHandler | undefined
      if (handler) handler({}, {}, () => undefined)
    },
    _fireError() {
      const handler = hooks['onError'] as ErrorHookHandler | undefined
      if (handler) handler({}, {}, new Error('test'), () => undefined)
    },
  }
  return app as unknown as FastifyInstance & { _fire(e: 'onRequest' | 'onResponse'): void; _fireError(): void }
}

describe('createDrainController', () => {
  it('registers onRequest, onResponse, and onError hooks', () => {
    const app = makeFakeFastify()
    createDrainController(app)
    expect(app.addHook).toHaveBeenCalledWith('onRequest', expect.any(Function))
    expect(app.addHook).toHaveBeenCalledWith('onResponse', expect.any(Function))
    expect(app.addHook).toHaveBeenCalledWith('onError', expect.any(Function))
  })

  it('tracks in-flight count correctly', () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app)
    expect(ctrl.inFlightCount).toBe(0)

    app._fire('onRequest')
    expect(ctrl.inFlightCount).toBe(1)

    app._fire('onRequest')
    expect(ctrl.inFlightCount).toBe(2)

    app._fire('onResponse')
    expect(ctrl.inFlightCount).toBe(1)

    app._fire('onResponse')
    expect(ctrl.inFlightCount).toBe(0)
  })

  it('decrements in-flight count on onError', () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app)

    app._fire('onRequest')
    expect(ctrl.inFlightCount).toBe(1)

    app._fireError()
    expect(ctrl.inFlightCount).toBe(0)
  })

  it('drain() resolves immediately when no in-flight requests', async () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app)
    await expect(ctrl.drain()).resolves.toBeUndefined()
  })

  it('drain() waits until in-flight count drops to zero', async () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app, { pollIntervalMs: 10, drainTimeoutMs: 2000 })

    app._fire('onRequest')
    expect(ctrl.inFlightCount).toBe(1)

    // Simulate request completing after a short delay
    setTimeout(() => app._fire('onResponse'), 50)

    const start = Date.now()
    await ctrl.drain()
    const elapsed = Date.now() - start

    expect(ctrl.inFlightCount).toBe(0)
    // Should have waited at least 40ms for the response to fire
    expect(elapsed).toBeGreaterThanOrEqual(30)
  })

  it('drain() resolves after timeout even if requests remain in-flight', async () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app, { pollIntervalMs: 10, drainTimeoutMs: 100 })

    app._fire('onRequest')
    // Never fire onResponse — simulate a stuck request

    const start = Date.now()
    await ctrl.drain() // should resolve after ~100ms
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(90)
    // Still has the in-flight request
    expect(ctrl.inFlightCount).toBe(1)
  })

  it('does not go below zero on extra onResponse calls', () => {
    const app = makeFakeFastify()
    const ctrl = createDrainController(app)

    app._fire('onRequest')
    app._fire('onResponse')
    app._fire('onResponse') // extra — should clamp at 0

    expect(ctrl.inFlightCount).toBe(0)
  })
})
