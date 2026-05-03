/**
 * restore-guard.ts — Database non-empty guard for restore operations.
 *
 * Exported for use by the CLI restore command (`cli/restore.ts`).
 *
 * Usage:
 *   import { assertDatabaseEmptyOrConfirmed } from './packages/orchestrator/src/audit-export/restore-guard.js'
 *   await assertDatabaseEmptyOrConfirmed(db, { force: flags.force })
 *
 * The guard counts rows in the five key tables that represent user-authored
 * data (events, tasks, sprints, channel_posts, vision_documents). If any
 * table has rows and `force` is not set, it throws OrbitalError with code
 * CONFLICT_RESTORE_NON_EMPTY so the CLI can display a human-readable error
 * without overwriting production data.
 */
import type { DB } from '@orbital/db';
export interface RestoreGuardOptions {
    /**
     * When true, skip the non-empty check entirely.
     * Pass `--force` from the CLI to set this.
     */
    force?: boolean;
}
export interface TableCount {
    table: string;
    count: number;
}
/**
 * Assert that the database is empty or that the caller has explicitly opted
 * in to overwriting existing data via `force: true`.
 *
 * @throws OrbitalError('CONFLICT_RESTORE_NON_EMPTY') when data exists and force is not set.
 */
export declare function assertDatabaseEmptyOrConfirmed(db: DB, opts?: RestoreGuardOptions): Promise<void>;
//# sourceMappingURL=restore-guard.d.ts.map