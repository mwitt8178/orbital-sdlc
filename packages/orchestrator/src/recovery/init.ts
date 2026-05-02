/**
 * recovery/init.ts — first-run initialisation logic.
 *
 * Moved from cli/init.ts. Used by integration tests that need to run the
 * init sequence against a real database without going through the scripts
 * entry point.
 *
 * Sequence (every step is idempotent):
 *   1. Resolve ORBITAL_HOME, mkdir -p config/ backup/wal/ backup/snapshots/ logs/.
 *   2. Optionally: docker compose up -d.
 *   3. Wait for Postgres readiness.
 *   4. Run drizzle migrations.
 *   5. Generate master signing key if no active master exists.
 *   6. Write default capability-policy.local.ts (idempotent).
 *   7. Write install.json with setup_completed_at: null (signals wizard on first visit).
 *   8. Optionally open browser.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { loadOrCreateInstall } from '../config/install.js'
import { getOrbitalHome } from '../config/env.js'
import { db, sql, closeDb } from '../db/client.js'
import { createEventStore } from '../events/store.js'
import { KeyManager } from '../capabilities/keys.js'
import { runSync, info, warn, exitWithError } from './io.js'
import type { Actor } from '@orbital/types'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface InitOptions {
  skipDocker?: boolean
  composeRoot?: string
  /** When true, do not close the shared DB pool — used by integration tests. */
  keepDbOpen?: boolean
  /**
   * When true, suppress the browser-open call (used by integration tests and CI).
   */
  skipBrowserOpen?: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveMigrationsFolder(): string {
  // Built layout: dist/recovery/init.js -> dist/db/migrations
  // Source layout: src/recovery/init.ts  -> src/db/migrations
  return path.resolve(__dirname, '..', 'db', 'migrations')
}

async function resolveComposeRoot(override?: string): Promise<string | null> {
  if (override) return override
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    try {
      await fs.access(path.join(dir, 'docker-compose.yml'))
      return dir
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function ensureDirs(): Promise<void> {
  const home = getOrbitalHome()
  await fs.mkdir(path.join(home, 'config'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'backup', 'wal'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'backup', 'snapshots'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 })
}

async function checkDocker(): Promise<boolean> {
  const result = runSync('docker', ['--version'])
  if (result.status !== 0) {
    warn(
      'docker not reachable; skipping `docker compose up`. ' +
        'Install Docker Desktop or set DATABASE_URL to point at an externally-managed Postgres.',
    )
    return false
  }
  return true
}

async function dockerComposeUp(composeRoot: string): Promise<void> {
  info(`> docker compose up -d (cwd=${composeRoot})`)
  const result = runSync('docker', ['compose', 'up', '-d'], {
    cwd: composeRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (result.status !== 0) {
    exitWithError('docker compose up failed; see output above', 1)
  }
}

async function waitForPostgres(timeoutMs: number = 60_000): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      await sql`SELECT 1`
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  throw new Error(`Postgres did not become ready within ${timeoutMs}ms: ${String(lastErr)}`)
}

async function runMigrations(): Promise<void> {
  info('> running migrations…')
  const folder = resolveMigrationsFolder()
  await migrate(db, { migrationsFolder: folder })
  info('  migrations complete')
}

async function ensureMasterKey(installId: string): Promise<{ keyId: string; created: boolean }> {
  const eventStore = createEventStore(db, sql)
  const km = new KeyManager(installId, eventStore)
  const existing = await km.getActiveMaster()
  if (existing) {
    info(`  master signing key present (key_id=${existing.keyId})`)
    return { keyId: existing.keyId, created: false }
  }
  info('> generating master signing key…')
  const next = await km.generateMaster(SYSTEM_ACTOR)
  info(`  master signing key generated (key_id=${next.keyId})`)
  return { keyId: next.keyId, created: true }
}

async function ensureDefaultPolicy(): Promise<void> {
  const home = getOrbitalHome()
  const target = path.join(home, 'config', 'capability-policy.local.ts')
  try {
    await fs.access(target)
    info('  capability-policy.local.ts already present')
    return
  } catch {
    // create it
  }
  const stub = `/**
 * capability-policy.local.ts — local override for capability defaults.
 */
export const localPolicyOverrides = {
  // perPersona: {
  //   'senior-developer': {
  //     files_write: ['src/billing/**'],
  //   },
  // },
}
`
  await fs.writeFile(target, stub, { mode: 0o600 })
  info('  wrote default capability-policy.local.ts')
}

async function ensureSetupCompletedAtField(): Promise<void> {
  const home = getOrbitalHome()
  const configPath = path.join(home, 'config', 'install.json')

  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }

  if ('setup_completed_at' in parsed) return

  parsed['setup_completed_at'] = null
  await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
  info('  install.json: setup_completed_at=null (wizard will run on first visit)')
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runInit(options: InitOptions = {}): Promise<void> {
  info('orbital init')

  await ensureDirs()

  const externalDb = !!(process.env['DATABASE_URL'] ?? '')
  if (!options.skipDocker && !externalDb) {
    const dockerOk = await checkDocker()
    if (dockerOk) {
      const composeRoot = await resolveComposeRoot(options.composeRoot)
      if (!composeRoot) {
        warn('docker-compose.yml not found upward from cwd; skipping compose up')
      } else {
        await dockerComposeUp(composeRoot)
      }
    }
  } else if (externalDb) {
    info('  DATABASE_URL set — skipping docker compose up (using external Postgres)')
  }

  info('> waiting for Postgres readiness…')
  await waitForPostgres()
  info('  Postgres reachable')

  await runMigrations()

  const install = await loadOrCreateInstall()
  info(`  install_id=${install.install_id}`)

  await ensureMasterKey(install.install_id)
  await ensureDefaultPolicy()
  await ensureSetupCompletedAtField()

  if (!options.keepDbOpen) {
    await closeDb()
  }
}
