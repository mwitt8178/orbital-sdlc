#!/usr/bin/env node
/* global process */
/**
 * scripts/setup.mjs — `npm run setup`
 *
 * Fresh-install command. Replaces the deprecated `orbital init`.
 *
 * Sequence (every step is idempotent — re-running picks up where it left off):
 *   1. Ensure ~/.orbital/ directories exist.
 *   2. docker compose up -d (skipped if DATABASE_URL points at an external Postgres).
 *   3. Wait for Postgres readiness (max 60 s).
 *   4. Run drizzle migrations via npx tsx packages/orchestrator/src/db/migrate.ts.
 *   5. Load or create install.json (via loadOrCreateInstall).
 *   6. Generate master signing key if absent.
 *   7. Write default capability-policy.local.ts (idempotent).
 *   8. Ensure install.json has setup_completed_at field.
 *   9. Open browser at http://localhost:3000 (best-effort).
 *  10. Print completion message.
 *
 * Flags:
 *   --skip-docker      Skip docker compose up (use external Postgres).
 *   --compose-root P   Override docker compose project root.
 *   --skip-browser     Do not open the browser at the end (CI use).
 *
 * Exit codes:
 *   0 — setup completed
 *   non-zero — failure surfaced to caller
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn, exec } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)

function hasFlag(name) {
  return argv.includes(name)
}

function parseFlag(name) {
  const idx = argv.indexOf(name)
  if (idx === -1) return undefined
  const next = argv[idx + 1]
  if (next === undefined || next.startsWith('--')) return undefined
  return next
}

const skipDocker = hasFlag('--skip-docker')
const composeRootOverride = parseFlag('--compose-root')
const skipBrowser = hasFlag('--skip-browser')

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function info(msg) {
  process.stdout.write(`${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`warning: ${msg}\n`)
}

function fatal(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// ORBITAL_HOME resolution
// ---------------------------------------------------------------------------

function getOrbitalHome() {
  if (process.env.ORBITAL_HOME) return process.env.ORBITAL_HOME
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) fatal('Cannot resolve user home directory')
  return `${home}/.orbital`
}

// ---------------------------------------------------------------------------
// Step 1 — ensure directories
// ---------------------------------------------------------------------------

async function ensureDirs() {
  const home = getOrbitalHome()
  await fs.mkdir(path.join(home, 'config'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'backup', 'wal'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'backup', 'snapshots'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 })
}

// ---------------------------------------------------------------------------
// Step 2 — docker compose up
// ---------------------------------------------------------------------------

function runSync(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...options,
  })
  const stdout =
    typeof result.stdout === 'string' ? result.stdout
    : Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf-8')
    : ''
  const stderr =
    typeof result.stderr === 'string' ? result.stderr
    : Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf-8')
    : ''
  return { status: result.status ?? -1, stdout, stderr }
}

function checkDocker() {
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

async function resolveComposeRoot(override) {
  if (override) return override
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
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

async function dockerComposeUp(composeRoot) {
  info(`> docker compose up -d (cwd=${composeRoot})`)
  const result = runSync('docker', ['compose', 'up', '-d'], {
    cwd: composeRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    fatal('docker compose up failed; see output above')
  }
}

// ---------------------------------------------------------------------------
// Step 3 — wait for Postgres
// ---------------------------------------------------------------------------

async function waitForPostgres(timeoutMs = 60_000) {
  info('> waiting for Postgres readiness…')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = runSync(
      'docker',
      ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'orbital'],
      { cwd: repoRoot },
    )
    if (result.status === 0) {
      info('  Postgres reachable')
      return
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  // If docker probe failed, try a direct connection attempt via the tsx path.
  // At minimum we print a warning and continue — migrations will surface any real error.
  warn('pg_isready probe timed out; proceeding anyway (migrations will verify connectivity)')
}

// ---------------------------------------------------------------------------
// Step 4 — run migrations
// ---------------------------------------------------------------------------

async function runMigrations() {
  info('> running migrations…')
  const tsxBin = path.join(
    repoRoot, 'node_modules', '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  )
  const migrateSrc = path.join(repoRoot, 'packages', 'orchestrator', 'src', 'db', 'migrate.ts')
  const result = spawnSync(tsxBin, [migrateSrc], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
  })
  if ((result.status ?? 1) !== 0) {
    fatal('migrations failed; see output above')
  }
  info('  migrations complete')
}

// ---------------------------------------------------------------------------
// Steps 5-8 — install.json, master key, policy, setup_completed_at
// These are delegated to the orchestrator source via tsx so we get the real
// TypeScript implementations without duplicating logic.
// ---------------------------------------------------------------------------

async function runInitSteps() {
  info('> initialising install.json and master signing key…')
  // We execute a small inline TypeScript driver via tsx that calls
  // loadOrCreateInstall + KeyManager — same logic as the old cli/init.ts
  // but without the CLI wrapper.
  const driver = `
import { loadOrCreateInstall } from './packages/orchestrator/src/config/install.js'
import { getOrbitalHome } from './packages/orchestrator/src/config/env.js'
import { db, sql, closeDb } from './packages/orchestrator/src/db/client.js'
import { createEventStore } from './packages/orchestrator/src/events/store.js'
import { KeyManager } from './packages/orchestrator/src/capabilities/keys.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' }

const install = await loadOrCreateInstall()
process.stdout.write('  install_id=' + install.install_id + '\\n')

const eventStore = createEventStore(db, sql)
const km = new KeyManager(install.install_id, eventStore)
const existing = await km.getActiveMaster()
if (existing) {
  process.stdout.write('  master signing key present (key_id=' + existing.keyId + ')\\n')
} else {
  process.stdout.write('> generating master signing key…\\n')
  const next = await km.generateMaster(SYSTEM_ACTOR)
  process.stdout.write('  master signing key generated (key_id=' + next.keyId + ')\\n')
}

// Ensure capability-policy.local.ts
const home = getOrbitalHome()
const policyTarget = path.join(home, 'config', 'capability-policy.local.ts')
try {
  await fs.access(policyTarget)
  process.stdout.write('  capability-policy.local.ts already present\\n')
} catch {
  const stub = [
    '/** capability-policy.local.ts — local override for capability defaults. */',
    'export const localPolicyOverrides = {',
    '  // perPersona: { \\'senior-developer\\': { files_write: [\\'src/billing/**\\'] } }',
    '}',
    '',
  ].join('\\n')
  await fs.writeFile(policyTarget, stub, { mode: 0o600 })
  process.stdout.write('  wrote default capability-policy.local.ts\\n')
}

// Ensure setup_completed_at field in install.json
const configPath = path.join(home, 'config', 'install.json')
try {
  const raw = await fs.readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw)
  if (!('setup_completed_at' in parsed)) {
    parsed.setup_completed_at = null
    await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), { mode: 0o600 })
    process.stdout.write('  install.json: setup_completed_at=null (wizard will run on first visit)\\n')
  }
} catch {
  // ENOENT or parse error — leave for loadOrCreateInstall to handle next run
}

await closeDb()
`
  // Write driver to a temp file then execute with tsx
  const tmpDir = path.join(repoRoot, 'node_modules', '.tmp-setup-driver')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, 'init-driver.ts')
  await fs.writeFile(tmpFile, driver, 'utf-8')

  const tsxBin = path.join(
    repoRoot, 'node_modules', '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  )
  const result = spawnSync(tsxBin, [tmpFile], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
  })
  // Clean up temp file
  await fs.rm(tmpFile, { force: true }).catch(() => undefined)

  if ((result.status ?? 1) !== 0) {
    fatal('init steps failed; see output above')
  }
}

// ---------------------------------------------------------------------------
// Step 9 — open browser
// ---------------------------------------------------------------------------

function openBrowser(url) {
  info(`Open your browser at: ${url}`)
  let cmd, args
  switch (process.platform) {
    case 'darwin':
      cmd = 'open'
      args = [url]
      break
    case 'linux':
      cmd = 'xdg-open'
      args = [url]
      break
    case 'win32':
      cmd = 'cmd'
      args = ['/c', 'start', '', url]
      break
    default:
      warn(`unsupported platform "${process.platform}" — open ${url} manually`)
      return
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // Non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  info('orbital setup')

  await ensureDirs()

  const externalDb = !!(process.env.DATABASE_URL ?? '')
  if (!skipDocker && !externalDb) {
    const dockerOk = checkDocker()
    if (dockerOk) {
      const composeRoot = await resolveComposeRoot(composeRootOverride) ?? repoRoot
      if (!composeRoot) {
        warn('docker-compose.yml not found upward from cwd; skipping compose up')
      } else {
        await dockerComposeUp(composeRoot)
      }
    }
  } else if (externalDb) {
    info('  DATABASE_URL set — skipping docker compose up (using external Postgres)')
  }

  await waitForPostgres()
  await runMigrations()
  await runInitSteps()

  if (!skipBrowser) {
    openBrowser('http://localhost:3000')
  }

  info('')
  info('Orbital is ready. Open http://localhost:3000 to finish setup')
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
})
