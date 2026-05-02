/**
 * audit/monday-drift.ts — Factory for the Monday board drift check callback.
 *
 * Per TRD-07 §7 (Monday drift) and the DriftReconciler options interface.
 *
 * This module provides the `checkMonday` callback that DriftReconciler accepts
 * as an optional constructor option. It calls MondaySyncService.reconcile(boardId)
 * and converts the result to DriftDetail[] for the reconciler.
 *
 * Wiring snippet (for boot agent — src/orchestration/boot.ts):
 * ```ts
 * import { createMondayDriftCheck } from './audit/monday-drift.js'
 *
 * const mondayDriftCheck = createMondayDriftCheck({
 *   syncService: mondaySyncService,
 *   boardId: env.MONDAY_BOARD_ID,          // undefined if not configured
 * })
 *
 * const reconciler = createDriftReconciler(db, sql, eventStore, {
 *   checkMonday: mondayDriftCheck,
 * })
 * ```
 *
 * If `boardId` is undefined or empty, the returned callback is a no-op that
 * returns an empty array. This is intentional: installs without Monday
 * integration should not see reconciler errors.
 */

import { logger } from '../config/logger.js'
import type { MondaySyncService } from '../backlog/monday-sync.js'
import type { DriftDetail } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MondayDriftCheckOptions {
  /** The MondaySyncService instance to use for reconciliation. */
  syncService: MondaySyncService
  /**
   * The Monday board ID to reconcile against.
   * If undefined/empty, the callback is a no-op.
   */
  boardId?: string | undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `checkMonday` callback compatible with `DriftReconcilerOptions`.
 *
 * Returns a function that:
 *   - Returns [] immediately if boardId is not configured.
 *   - Calls syncService.reconcile(boardId) and maps drift rows to DriftDetail[].
 *   - Logs and returns [] (not throws) on reconcile errors to avoid interrupting
 *     the wider reconciliation run.
 */
export function createMondayDriftCheck(
  opts: MondayDriftCheckOptions,
): () => Promise<DriftDetail[]> {
  const { syncService, boardId } = opts

  if (!boardId) {
    logger.debug(
      'monday-drift: no boardId configured; Monday drift check is a no-op',
    )
    return async () => []
  }

  return async (): Promise<DriftDetail[]> => {
    let result: Awaited<ReturnType<MondaySyncService['reconcile']>>
    try {
      result = await syncService.reconcile(boardId)
    } catch (err) {
      logger.warn(
        { err, boardId },
        'monday-drift: MondaySyncService.reconcile failed; skipping Monday drift check',
      )
      return []
    }

    const drifts: DriftDetail[] = []

    if (result.driftCount > 0) {
      // MondaySyncService.reconcile returns aggregate counts, not per-item details.
      // We emit one DriftDetail per drift category to surface the count to the
      // reconciler. If finer-grained details are needed, wire a richer reconcile
      // API in a future phase.
      drifts.push({
        source: 'monday',
        drift_kind: 'monday_status_without_event',
        observed: {
          board_id: boardId,
          drift_count: result.driftCount,
          pulled_count: result.pulledCount,
          detail: `Monday board ${boardId} has ${result.driftCount} item(s) whose status differs from the local sprint/story state`,
        },
        expected: {
          description: 'All Monday board items should mirror their Orbital story status',
          board_id: boardId,
        },
        severity: 'warning',
      })

      logger.warn(
        { boardId, driftCount: result.driftCount, pulledCount: result.pulledCount },
        'monday-drift: Monday board drift detected',
      )
    } else {
      logger.debug(
        { boardId, pulledCount: result.pulledCount },
        'monday-drift: no drift found in Monday board',
      )
    }

    return drifts
  }
}
