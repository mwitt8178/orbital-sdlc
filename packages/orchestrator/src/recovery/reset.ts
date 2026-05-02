/**
 * recovery/reset.ts — emergency wipe command.
 *
 * Moved from cli/reset.ts. Drops all orbital schemas, re-runs migrations,
 * and writes a fresh install.json with a new install_id.
 *
 * This module is used by both scripts/reset.mjs (CLI surface) and the
 * admin.reset.danger tRPC procedure (daemon surface). When called from
 * the daemon, pass `forceWhileRunning: true`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from 'uuidv7'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadEnv, getOrbitalHome } from '../config/env.js'
import { db, closeDb } from '../db/client.js'
import { resetInstallCache } from '../config/install.js'
import { resetKeychainCache } from '../capabilities/keychain.js'
import { runSync, info, warn, exitWithError } from './io.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ResetOptions {
  /** Must be true or the command aborts. */
  confirmed: boolean
  /** Skip the daemon-running check (used when called from the daemon itself). */
  forceWhileRunning?: boolean
  /** Override orbital home (tests). */
  orbitalHomeOverride?: string
  /** When true, do not close the shared DB pool — used by integration tests. */
  keepDbOpen?: boolean
}

export interface ResetResult {
  newInstallId: string
  schemasDropped: true
  migrationsRun: true
}

async function checkDaemonNotRunning(): Promise<void> {
  const env = loadEnv()
  const url = `http://localhost:${String(env.PORT)}/health`
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 1_500)
    const res = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    if (res.ok) {
      exitWithError(
        `daemon appears to be running at ${url}. Stop it (Ctrl-C) before running reset.`,
      )
    }
  } catch {
    // No daemon — we are clear.
  }
}

function dropSchemas(): void {
  info('> dropping all schemas…')
  const result = runSync(
    'docker',
    [
      'compose', 'exec', '-T', 'postgres',
      'psql', '-U', 'orbital', '-d', 'orbital',
      '-v', 'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  if (result.status !== 0) {
    const env = loadEnv()
    const hostResult = runSync(
      'psql',
      [
        env.DATABASE_URL,
        '-v', 'ON_ERROR_STOP=1',
        '-c',
        'DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
      ],
    )
    if (hostResult.status !== 0) {
      exitWithError(
        `schema drop failed (docker: ${result.stderr.trim() || 'n/a'}, host: ${hostResult.stderr.trim() || 'n/a'})`,
      )
    }
  }
  info('  schemas dropped')
}

async function runMigrations(): Promise<void> {
  info('> running migrations on clean schema…')
  // Built layout: dist/recovery/reset.js -> dist/db/migrations
  const folder = path.resolve(__dirname, '..', 'db', 'migrations')
  await migrate(db, { migrationsFolder: folder })
  info('  migrations complete')
}

async function writeNewInstallJson(orbitalHome: string): Promise<string> {
  const configDir = path.join(orbitalHome, 'config')
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
  const newInstallId = uuidv7()
  const config = {
    install_id: newInstallId,
    created_at: new Date().toISOString(),
    schema_version: 1,
    setup_completed_at: null,
  }
  await fs.writeFile(
    path.join(configDir, 'install.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  )
  resetInstallCache()
  resetKeychainCache()
  return newInstallId
}

export async function runReset(options: ResetOptions): Promise<ResetResult> {
  if (!options.confirmed) {
    exitWithError(
      'reset requires confirmation. ' +
        'This command will DESTROY ALL DATA in the Orbital database. ' +
        'Set RESET_PHRASE="I understand" to proceed.',
    )
  }

  warn('ORBITAL RESET: This will destroy all data in the Orbital database.')
  warn('There is no undo. Make a backup first if you need to preserve data.')
  warn('')

  if (!options.forceWhileRunning) {
    await checkDaemonNotRunning()
  }

  const orbitalHome = options.orbitalHomeOverride ?? getOrbitalHome()

  dropSchemas()
  await runMigrations()

  const newInstallId = await writeNewInstallJson(orbitalHome)
  info(`  new install_id=${newInstallId}`)

  info('')
  info('reset: done')
  info('Run `npm run setup` to regenerate keys and open the setup wizard.')

  if (!options.keepDbOpen) {
    await closeDb()
  }

  return {
    newInstallId,
    schemasDropped: true,
    migrationsRun: true,
  }
}
