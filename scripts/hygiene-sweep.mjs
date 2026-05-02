#!/usr/bin/env node
/* global process */
/**
 * scripts/hygiene-sweep.mjs — `npm run hygiene`
 *
 * Cleans accumulated test/fixture data from agent runs WITHOUT deleting rows.
 * All operations are state transitions that preserve the full audit trail.
 *
 * Required:
 *   DATABASE_URL=postgres://orbital:orbital@localhost:5432/orbital
 *
 * Optional:
 *   DRY_RUN=1            — preview only; no mutations committed
 *   OLDER_THAN_DAYS=N    — escalation age cutoff in days (default: 0 = all open)
 *
 * Examples:
 *   DATABASE_URL=... npm run hygiene
 *   DATABASE_URL=... DRY_RUN=1 npm run hygiene
 *   DATABASE_URL=... OLDER_THAN_DAYS=30 npm run hygiene
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const driverEntry = path.join(__dirname, '_hygiene-driver.ts')

const tsxBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)

const child = spawn(tsxBin, [driverEntry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Ensure tsx resolves imports from the repo root
    NODE_PATH: path.join(repoRoot, 'node_modules'),
  },
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
