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

import { sql as dSQL } from 'drizzle-orm'
import { OrbitalError } from '@orbital/types'
import type { DB } from '../db/client.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestoreGuardOptions {
  /**
   * When true, skip the non-empty check entirely.
   * Pass `--force` from the CLI to set this.
   */
  force?: boolean
}

export interface TableCount {
  table: string
  count: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assert that the database is empty or that the caller has explicitly opted
 * in to overwriting existing data via `force: true`.
 *
 * @throws OrbitalError('CONFLICT_RESTORE_NON_EMPTY') when data exists and force is not set.
 */
export async function assertDatabaseEmptyOrConfirmed(
  db: DB,
  opts: RestoreGuardOptions = {},
): Promise<void> {
  if (opts.force) {
    logger.warn('restore-guard: --force set; skipping non-empty check')
    return
  }

  const counts = await countTableRows(db)
  const nonEmpty = counts.filter((c) => c.count > 0)

  if (nonEmpty.length === 0) {
    logger.debug('restore-guard: database is empty; safe to restore')
    return
  }

  const detail = nonEmpty.map((c) => `${c.table}: ${c.count} row(s)`).join(', ')
  logger.error({ nonEmpty }, 'restore-guard: database has existing data; refusing restore')

  throw new OrbitalError(
    'CONFLICT_RESTORE_NON_EMPTY',
    `Database has existing data (${detail}). Use --force to overwrite.`,
    {
      non_empty_tables: nonEmpty,
      recovery_advice:
        'Run with --force to overwrite, or manually truncate the tables before restoring.',
    },
    'no_retry',
  )
}

/**
 * Count rows in the five key tables representing user-authored data.
 * Uses COUNT(*) per table so the query is cheap and avoids full scans.
 */
async function countTableRows(db: DB): Promise<TableCount[]> {
  // Use raw SQL to avoid importing every schema table into this module and to
  // keep the queries straightforward and schema-version-independent.
  const tables = [
    { table: 'events', query: dSQL`SELECT COUNT(*)::int AS n FROM audit.events` },
    { table: 'tasks', query: dSQL`SELECT COUNT(*)::int AS n FROM tasks` },
    { table: 'sprints', query: dSQL`SELECT COUNT(*)::int AS n FROM sprints` },
    { table: 'channel_posts', query: dSQL`SELECT COUNT(*)::int AS n FROM channel_posts` },
    { table: 'vision_documents', query: dSQL`SELECT COUNT(*)::int AS n FROM vision_documents` },
  ]

  const results: TableCount[] = []

  for (const { table, query } of tables) {
    try {
      const rows = await db.execute<{ n: number }>(query)
      const row = (rows as unknown as Array<{ n: number }>)[0]
      results.push({ table, count: row?.n ?? 0 })
    } catch (err) {
      // Table may not exist yet (fresh install before migrations). Treat as 0.
      logger.debug({ err, table }, 'restore-guard: could not count table; treating as 0')
      results.push({ table, count: 0 })
    }
  }

  return results
}
