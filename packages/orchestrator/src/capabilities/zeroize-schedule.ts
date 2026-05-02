/**
 * zeroize-schedule.ts — Boot-time helper for daily key zeroization.
 *
 * Per TRD-06 v0.2 §4.3 + SAO §5.4 (retention window):
 * Sub-key private bytes must be zeroized 30 days after sprint close.
 * This helper registers a daily interval that calls `zeroizeOldKeys`.
 *
 * NOTE TO BOOT AGENT: add the following lines to src/index.ts after
 * `keyManager` is instantiated (after `new KeyManager(…)`):
 *
 *   import { registerKeyZeroizeSchedule } from './capabilities/zeroize-schedule.js'
 *   import { KeyZeroizeService } from './capabilities/zeroize.js'
 *   const keyZeroizeService = new KeyZeroizeService(eventStore)
 *   const stopKeyZeroize = registerKeyZeroizeSchedule({ keyZeroizeService })
 *
 * Then add `stopKeyZeroize()` to the shutdown handler.
 *
 * The service does not need the KeyManager — it operates directly on the
 * signing_keys table and keychain.
 */

import { logger } from '../config/logger.js'
import type { ZeroizeResult } from './zeroize.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the service that handles zeroization.
 * Declared here so unit tests can inject a stub without importing the full
 * KeyZeroizeService with its DB dependency.
 */
export interface ZeroizableService {
  zeroizeOldKeys(olderThanDays?: number): Promise<ZeroizeResult>
}

export interface RegisterKeyZeroizeScheduleOptions {
  keyZeroizeService: ZeroizableService
  /**
   * Interval between zeroization sweeps in milliseconds.
   * Default: 24 hours.
   */
  intervalMs?: number
  /**
   * How many days before zeroization. Default: 30.
   * Matches SAO §5.4 retention window.
   */
  olderThanDays?: number
}

export interface KeyZeroizeScheduleHandle {
  /** Stop the periodic zeroization timer. Safe to call multiple times. */
  stop(): void
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_OLDER_THAN_DAYS = 30

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Register a periodic key zeroization sweep.
 *
 * Calls `keyZeroizeService.zeroizeOldKeys(olderThanDays)` at `intervalMs`
 * intervals. The timer is unref'd so it does not keep the process alive.
 *
 * Returns a handle with a `stop()` method for graceful shutdown.
 */
export function registerKeyZeroizeSchedule(
  opts: RegisterKeyZeroizeScheduleOptions,
): KeyZeroizeScheduleHandle {
  const {
    keyZeroizeService,
    intervalMs = DEFAULT_INTERVAL_MS,
    olderThanDays = DEFAULT_OLDER_THAN_DAYS,
  } = opts

  // Run once at startup (fire-and-forget — startup should not block on this).
  void keyZeroizeService.zeroizeOldKeys(olderThanDays).then((result) => {
    logger.info(
      { zeroizedCount: result.zeroizedCount, errors: result.errors.length },
      'registerKeyZeroizeSchedule: initial sweep completed',
    )
  }).catch((err: unknown) => {
    logger.error({ err }, 'registerKeyZeroizeSchedule: initial sweep failed')
  })

  const timer = setInterval(() => {
    keyZeroizeService.zeroizeOldKeys(olderThanDays).then((result) => {
      if (result.zeroizedCount > 0 || result.errors.length > 0) {
        logger.info(
          { zeroizedCount: result.zeroizedCount, errors: result.errors.length },
          'registerKeyZeroizeSchedule: periodic sweep completed',
        )
      } else {
        logger.debug(
          { olderThanDays },
          'registerKeyZeroizeSchedule: periodic sweep — no candidates',
        )
      }
    }).catch((err: unknown) => {
      logger.error({ err }, 'registerKeyZeroizeSchedule: periodic sweep failed')
    })
  }, intervalMs)

  // Don't keep the event loop alive on this timer.
  if (typeof timer.unref === 'function') timer.unref()

  logger.info(
    { intervalMs, olderThanDays },
    'registerKeyZeroizeSchedule: key zeroization schedule registered',
  )

  return {
    stop() {
      clearInterval(timer)
      logger.info('registerKeyZeroizeSchedule: key zeroization schedule stopped')
    },
  }
}
