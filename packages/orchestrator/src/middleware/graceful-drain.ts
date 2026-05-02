/**
 * graceful-drain.ts — In-flight HTTP request drain controller for Fastify.
 *
 * Used by the boot shutdown path (src/orchestration/boot.ts) to await all
 * in-flight requests before calling app.close(). Prevents connections from
 * being forcibly terminated mid-request when SIGTERM fires.
 *
 * Usage (wiring snippet for boot agent):
 * ```ts
 * import { createDrainController } from './middleware/graceful-drain.js'
 *
 * const drainController = createDrainController(app, { drainTimeoutMs: 30_000 })
 *
 * // In SIGTERM handler (before app.close()):
 * await drainController.drain()
 * await app.close()
 * ```
 *
 * The controller registers onRequest/onResponse hooks on the Fastify app and
 * tracks the count of in-flight requests. `drain()` resolves when in-flight
 * count reaches zero or drainTimeoutMs elapses.
 */

import type { FastifyInstance } from 'fastify'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainControllerOptions {
  /**
   * Maximum time (ms) to wait for in-flight requests to complete before
   * force-resolving. Default: 30_000 (30 seconds).
   */
  drainTimeoutMs?: number
  /** Poll interval (ms) while waiting for in-flight count to reach 0. Default: 100. */
  pollIntervalMs?: number
}

export interface DrainController {
  /**
   * Await all in-flight requests to complete.
   * Resolves when in-flight count reaches 0 or drainTimeoutMs elapses.
   * Never rejects — a timeout is logged as a warning and resolves cleanly.
   */
  drain(): Promise<void>

  /** Current count of in-flight requests. Exposed for observability/tests. */
  readonly inFlightCount: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FastifyDrainController implements DrainController {
  private _inFlightCount = 0
  private readonly drainTimeoutMs: number
  private readonly pollIntervalMs: number

  constructor(
    private readonly app: FastifyInstance,
    opts: DrainControllerOptions = {},
  ) {
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 30_000
    this.pollIntervalMs = opts.pollIntervalMs ?? 100
    this.registerHooks()
  }

  get inFlightCount(): number {
    return this._inFlightCount
  }

  private registerHooks(): void {
    this.app.addHook('onRequest', (_req, _reply, done) => {
      this._inFlightCount++
      done()
    })

    this.app.addHook('onResponse', (_req, _reply, done) => {
      if (this._inFlightCount > 0) this._inFlightCount--
      done()
    })

    // onError fires for requests that error before reaching onResponse.
    this.app.addHook('onError', (_req, _reply, _err, done) => {
      if (this._inFlightCount > 0) this._inFlightCount--
      done()
    })
  }

  async drain(): Promise<void> {
    if (this._inFlightCount === 0) {
      logger.debug('DrainController.drain: no in-flight requests; resolving immediately')
      return
    }

    logger.info(
      { inFlightCount: this._inFlightCount, drainTimeoutMs: this.drainTimeoutMs },
      'DrainController.drain: waiting for in-flight requests to complete',
    )

    const deadline = Date.now() + this.drainTimeoutMs

    while (this._inFlightCount > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, this.pollIntervalMs))
    }

    if (this._inFlightCount > 0) {
      logger.warn(
        { inFlightCount: this._inFlightCount, drainTimeoutMs: this.drainTimeoutMs },
        'DrainController.drain: timeout elapsed with in-flight requests still open; proceeding with close',
      )
    } else {
      logger.info('DrainController.drain: all in-flight requests completed')
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a DrainController and register the tracking hooks on the Fastify
 * instance. Call this during app setup, before registering routes.
 *
 * Wiring snippet (for boot agent):
 * ```ts
 * const drainController = createDrainController(app, { drainTimeoutMs: 30_000 })
 *
 * const shutdown = async (signal: string) => {
 *   logger.info({ signal }, 'Shutdown signal received')
 *   await drainController.drain()
 *   await app.close()
 *   process.exit(0)
 * }
 * process.on('SIGTERM', () => void shutdown('SIGTERM'))
 * process.on('SIGINT', () => void shutdown('SIGINT'))
 * ```
 */
export function createDrainController(
  app: FastifyInstance,
  opts: DrainControllerOptions = {},
): DrainController {
  return new FastifyDrainController(app, opts)
}
