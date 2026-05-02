#!/usr/bin/env node
/* global process */
/**
 * scripts/restore.mjs — `npm run restore`
 *
 * Emergency disaster-recovery command. Restores the Orbital database and
 * keychain from an encrypted backup tarball. This is the ONLY command that
 * must work even if the daemon is dead.
 *
 * Inputs:
 *   --from <path>     OR   ORBITAL_BACKUP_PATH (env)
 *   --passphrase <p>  OR   ORBITAL_BACKUP_PASSPHRASE (env)
 *   --force           bypass the non-empty-DB safety guard
 *   --force-while-running  skip the daemon-running check (tests)
 *
 * Exit codes:
 *   0 — restore completed
 *   2 — missing required path or bad passphrase
 *   3 — DB non-empty and --force not set
 *   1 — anything else (decrypt fail, pg_restore fail, etc.)
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const fromFlag = parseFlag('--from')
const fromEnv = process.env.ORBITAL_BACKUP_PATH
const fromPath = fromFlag ?? fromEnv

if (!fromPath) {
  process.stderr.write(
    'error: backup path required.\n' +
      '  pass via --from <tarball> or set ORBITAL_BACKUP_PATH env var.\n',
  )
  process.exit(2)
}

const passphraseFlag = parseFlag('--passphrase')
const passphraseEnv = process.env.ORBITAL_BACKUP_PASSPHRASE
const passphrase = passphraseFlag ?? passphraseEnv

const force = hasFlag('--force')
const forceWhileRunning = hasFlag('--force-while-running')

// ---------------------------------------------------------------------------
// Delegate to recovery/restore.ts via tsx
//
// We build a tiny inline TypeScript driver that calls runRestore() directly.
// This avoids duplicating the restore logic in plain JS and ensures the same
// code path is exercised regardless of whether the caller is the CLI or a test.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs'

async function main() {
  // Escape values for safe string embedding in the driver snippet.
  const safeFromPath = fromPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const safePassphrase = passphrase != null
    ? `'${passphrase.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : 'undefined'

  const driver = `
import { runRestore } from './packages/orchestrator/src/recovery/restore.js'

const result = await runRestore({
  fromPath: '${safeFromPath}',
  passphrase: ${safePassphrase},
  force: ${force ? 'true' : 'false'},
  forceWhileRunning: ${forceWhileRunning ? 'true' : 'false'},
})
process.stdout.write('  restore completed, install_id=' + result.installId + '\\n')
`

  const tmpDir = path.join(repoRoot, 'node_modules', '.tmp-restore-driver')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, 'restore-driver.ts')
  await fs.writeFile(tmpFile, driver, 'utf-8')

  const tsxBin = path.join(
    repoRoot, 'node_modules', '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  )

  const child = spawnSync(tsxBin, [tmpFile], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
  })

  await fs.rm(tmpFile, { force: true }).catch(() => undefined)

  process.exit(child.status ?? 1)
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
})
