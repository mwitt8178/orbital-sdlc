#!/usr/bin/env node
/* global process */
/**
 * scripts/reset.mjs — `npm run reset`
 *
 * EMERGENCY WIPE. Drops every Orbital schema and re-runs migrations.
 *
 * Required environment variable:
 *   RESET_PHRASE="I understand"
 *
 * Without RESET_PHRASE the script aborts with a clear message. This is a
 * guardrail against accidental invocation, not a security control.
 *
 * After reset, run `npm run setup` to regenerate keys and re-open the
 * /welcome wizard.
 *
 * Exit codes:
 *   0 — reset completed
 *   2 — RESET_PHRASE not set or incorrect
 *   1 — anything else
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const REQUIRED_PHRASE = 'I understand'

const phrase = process.env.RESET_PHRASE

if (phrase !== REQUIRED_PHRASE) {
  process.stderr.write(
    [
      '',
      'orbital reset is destructive. To proceed, set the RESET_PHRASE env var:',
      '',
      `  RESET_PHRASE="${REQUIRED_PHRASE}" npm run reset`,
      '',
      'This will:',
      '  - DROP audit and public schemas',
      '  - re-run migrations on a clean database',
      '  - write a fresh install.json (new install_id, setup_completed_at: null)',
      '',
      'Run `npm run setup` afterward to regenerate keys and re-open the wizard.',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Delegate to recovery/reset.ts via tsx
// ---------------------------------------------------------------------------

async function main() {
  const hasForceWhileRunning = process.argv.includes('--force-while-running')

  const driver = `
import { runReset } from './packages/orchestrator/src/recovery/reset.js'

const result = await runReset({
  confirmed: true,
  forceWhileRunning: ${hasForceWhileRunning ? 'true' : 'false'},
})
process.stdout.write('  new install_id=' + result.newInstallId + '\\n')
`

  const tmpDir = path.join(repoRoot, 'node_modules', '.tmp-reset-driver')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, 'reset-driver.ts')
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
