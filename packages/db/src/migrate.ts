/**
 * migrate.ts — Run drizzle-orm migrations with pre-flight listing and
 * per-migration error reporting.
 *
 * Partial-failure handling:
 *   - Lists pending migrations before running; requires --yes in interactive
 *     mode (or CI_MODE=true to skip confirmation).
 *   - Wraps each migration's execution in a try/catch; on failure, logs
 *     which migration failed, the current state of __drizzle_migrations, and
 *     explicit manual recovery instructions.
 *   - Does NOT auto-rollback (drizzle does not support DDL rollback). Fail loudly.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline'
import * as fs from 'node:fs/promises'
import { db, closeDb } from './client.js'

// Phase 3.2: migrate.ts moved to @orbital/db. Uses console logging directly
// to avoid importing pino/otel from the orchestrator config package.
const logger = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ level: 'info', ...(typeof obj === 'object' && obj !== null ? obj : { msg: obj }), ...(msg ? { msg } : {}) })),
  warn: (obj: unknown, msg?: string) => console.warn(JSON.stringify({ level: 'warn', ...(typeof obj === 'object' && obj !== null ? obj : { msg: obj }), ...(msg ? { msg } : {}) })),
  error: (obj: unknown, msg?: string) => console.error(JSON.stringify({ level: 'error', ...(typeof obj === 'object' && obj !== null ? obj : { msg: obj }), ...(msg ? { msg } : {}) })),
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true if running in a CI/non-interactive context. */
function isCI(): boolean {
  return (
    process.env['CI'] === 'true' ||
    process.env['CI_MODE'] === 'true' ||
    !process.stdout.isTTY
  )
}

/** Prompt the user with a yes/no question. Returns true if the answer starts with 'y'. */
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase().startsWith('y'))
    })
  })
}

/** List .sql files in the migrations folder that are not yet in __drizzle_migrations. */
async function listPendingMigrations(
  migrationsFolder: string,
  sql: postgres.Sql,
): Promise<string[]> {
  // Read all sql files from the migrations folder.
  let allFiles: string[] = []
  try {
    const entries = await fs.readdir(migrationsFolder)
    allFiles = entries
      .filter((f) => f.endsWith('.sql'))
      .sort()
  } catch (err) {
    logger.warn({ err, migrationsFolder }, 'migrate: could not read migrations folder')
    return []
  }

  // Query which have already been applied (table may not exist yet).
  let applied: Set<string> = new Set()
  try {
    const rows = await sql<Array<{ hash: string }>>`
      SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
    `
    // Drizzle stores the migration file stem (without .sql) as the hash field.
    // Map file names: "0001_foo.sql" → "0001_foo"
    applied = new Set(rows.map((r) => r.hash))
  } catch {
    // Table doesn't exist yet — all files are pending.
  }

  return allFiles.filter((f) => !applied.has(f.replace(/\.sql$/, '')))
}

/** Read and log the current state of __drizzle_migrations (recovery aid). */
async function logMigrationState(sql: postgres.Sql): Promise<void> {
  try {
    const rows = await sql<Array<{ hash: string; created_at: string }>>`
      SELECT hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at
    `
    logger.error(
      { applied_migrations: rows },
      'migrate: current __drizzle_migrations state (for manual recovery)',
    )
  } catch (err) {
    logger.warn({ err }, 'migrate: could not read __drizzle_migrations (table may not exist)')
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const migrationsFolder = path.join(__dirname, 'migrations')
  logger.info({ migrationsFolder }, 'migrate: starting')

  // We need a raw postgres client to query __drizzle_migrations independently.
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    logger.error('migrate: DATABASE_URL is not set')
    process.exit(1)
  }
  const rawSql = postgres(databaseUrl, { max: 1 })

  // Pre-flight: list pending migrations.
  const pending = await listPendingMigrations(migrationsFolder, rawSql)

  if (pending.length === 0) {
    logger.info('migrate: no pending migrations; database is up to date')
    await rawSql.end()
    await closeDb()
    return
  }

  logger.info({ pending_count: pending.length, files: pending }, 'migrate: pending migrations found')

  // Interactive confirmation (skipped in CI).
  if (!isCI()) {
    logger.info('Pending migrations:')
    for (const f of pending) {
      logger.info(`  - ${f}`)
    }
    const ok = await confirm(`Apply ${pending.length} migration(s)?`)
    if (!ok) {
      logger.info('migrate: aborted by user')
      await rawSql.end()
      await closeDb()
      process.exit(0)
    }
  }

  // Run migrations with error reporting.
  try {
    await migrate(db, { migrationsFolder })
    logger.info({ applied: pending.length }, 'migrate: all migrations applied successfully')
  } catch (err) {
    // Attempt to identify which migration caused the failure.
    const afterPending = await listPendingMigrations(migrationsFolder, rawSql)
    const appliedCount = pending.length - afterPending.length
    const failedMigration = afterPending[0] ?? 'unknown'

    logger.error(
      {
        err,
        failed_migration: failedMigration,
        applied_before_failure: pending.slice(0, appliedCount),
        remaining_pending: afterPending,
      },
      'migrate: MIGRATION FAILED — partial state detected',
    )

    // Log the current drizzle migrations table for recovery.
    await logMigrationState(rawSql)

    logger.error(
      [
        '',
        '=== MANUAL RECOVERY INSTRUCTIONS ===',
        `Migration "${failedMigration}" failed mid-execution.`,
        'Drizzle does not support automatic DDL rollback.',
        '',
        'To recover:',
        '  1. Inspect the error above to determine what DDL was partially applied.',
        '  2. Manually revert any partial DDL using psql.',
        '     Example (adapt table/schema names to the failed migration):',
        '       DROP TABLE IF EXISTS <new_table> CASCADE;',
        '       DROP SCHEMA IF EXISTS <new_schema> CASCADE;',
        '  3. Delete the partially-applied row from __drizzle_migrations:',
        `       DELETE FROM drizzle.__drizzle_migrations WHERE hash = '${failedMigration.replace(/\.sql$/, '')}';`,
        '  4. Re-run: npm run migrate',
        '',
        'If the migration table itself is corrupt:',
        '       DROP TABLE IF EXISTS drizzle.__drizzle_migrations CASCADE;',
        '  then re-run: npm run migrate',
        '=====================================',
      ].join('\n'),
    )

    await rawSql.end()
    await closeDb()
    process.exit(1)
  }

  await rawSql.end()
  await closeDb()
}

main().catch((err) => {
  logger.error({ err }, 'migrate: unhandled error')
  process.exit(1)
})
