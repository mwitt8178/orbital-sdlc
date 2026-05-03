/**
 * reconcile-bootstrap.ts — boot-time helper for Monday periodic reconciliation.
 *
 * Per TRD-02 v0.2 §13.3: "Every 5 minutes, a worker pulls all items modified
 * since last_pull_at and compares to local state."
 *
 * `MondaySyncService.startScheduledReconcile(boardId)` exists and is correctly
 * implemented but is never called at boot. This helper provides the wiring
 * point while keeping boot wiring out of the library file.
 *
 * NOTE TO BOOT AGENT: add the following two lines to src/index.ts after the
 * `syncService` is created (inside the `if (webhookSecret …)` block, or in a
 * dedicated Monday startup block with your own syncService instance):
 *
 *   import { registerMondayReconciliation } from './backlog/reconcile-bootstrap.js'
 *   const stopMondayReconcile = registerMondayReconciliation({ syncService, boardId: env.MONDAY_BOARD_ID })
 *
 * Then add `stopMondayReconcile()` to the shutdown handler alongside
 * `stopInstrumentation()`.  `boardId` must be the Monday board ID string
 * (e.g. from env.MONDAY_BOARD_ID).  If `boardId` is absent or empty the
 * helper returns a no-op stop function and logs a warning.
 */

import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the subset of MondaySyncService that this helper
 * needs.  Declared here rather than imported so unit tests can supply a simple
 * stub without pulling in the full monday-sync module.
 */
export interface ReconcilableService {
  startScheduledReconcile(boardId: string): void
  stopScheduledReconcile(): void
}

export interface RegisterMondayReconciliationOptions {
  /** The MondaySyncService (or any object that satisfies ReconcilableService). */
  syncService: ReconcilableService
  /**
   * Monday board ID.  If absent or empty the helper is a no-op and returns a
   * no-op stop function.
   */
  boardId?: string | undefined
  /**
   * Override the reconciliation interval in milliseconds.
   * Default: 5 minutes (300 000 ms) — matches TRD-02 §14 SLO.
   * If provided this value is injected by calling
   * `syncService.startScheduledReconcile` — the interval must already be
   * configured on the service (via `reconcileIntervalMs` option in the
   * constructor) or be ignored if the service uses its own default.
   *
   * This parameter exists here only so the unit test can override the service's
   * built-in timer via the test stub.  The real DefaultMondaySyncService sets
   * its interval in its constructor; pass the same value there.
   */
  intervalMs?: number
}

export interface ReconciliationHandle {
  /** Stop the periodic reconciliation timer. */
  stop(): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Register Monday periodic reconciliation at boot.
 *
 * Calls `syncService.startScheduledReconcile(boardId)` and returns a handle
 * with a `stop()` method that calls `syncService.stopScheduledReconcile()`.
 *
 * Idempotent: `startScheduledReconcile` is already guarded against double-start.
 *
 * @returns handle with `stop()` — pass to shutdown handler.
 */
export function registerMondayReconciliation(
  opts: RegisterMondayReconciliationOptions,
): ReconciliationHandle {
  const { syncService, boardId } = opts

  if (!boardId || boardId.trim() === '') {
    logger.warn(
      'registerMondayReconciliation: boardId is absent or empty; skipping Monday periodic reconciliation.',
    )
    return { stop: () => undefined }
  }

  syncService.startScheduledReconcile(boardId)
  logger.info({ boardId }, 'registerMondayReconciliation: Monday periodic reconciliation started')

  return {
    stop() {
      syncService.stopScheduledReconcile()
      logger.info({ boardId }, 'registerMondayReconciliation: Monday periodic reconciliation stopped')
    },
  }
}
