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
import { logger } from '../logger.js';
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
export function registerMondayReconciliation(opts) {
    const { syncService, boardId } = opts;
    if (!boardId || boardId.trim() === '') {
        logger.warn('registerMondayReconciliation: boardId is absent or empty; skipping Monday periodic reconciliation.');
        return { stop: () => undefined };
    }
    syncService.startScheduledReconcile(boardId);
    logger.info({ boardId }, 'registerMondayReconciliation: Monday periodic reconciliation started');
    return {
        stop() {
            syncService.stopScheduledReconcile();
            logger.info({ boardId }, 'registerMondayReconciliation: Monday periodic reconciliation stopped');
        },
    };
}
//# sourceMappingURL=reconcile-bootstrap.js.map