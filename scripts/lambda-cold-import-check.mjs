#!/usr/bin/env node
/**
 * lambda-cold-import-check.mjs — Prove Lambda bundle(s) are import-time safe.
 *
 * Why: Lambda containers crash during INIT if the imported module graph
 * touches the filesystem ($HOME, ~/.orbital), spawns child processes,
 * opens sockets, or throws on missing env vars. AWS reports these as
 * `Runtime.Unknown` with a stack trace from /var/task/*.js — there is no
 * useful debugger because the user code never runs.
 *
 * What this does: spawn a fresh child Node process under conditions that
 * approximate the worst Lambda init env — no HOME, no USERPROFILE, only
 * the ORBITAL_* env vars a Lambda actually has — and dynamic-import the
 * bundle. If it throws, this script exits non-zero and prints the stack.
 *
 * Usage:
 *   node scripts/lambda-cold-import-check.mjs <bundle-path>
 *   node scripts/lambda-cold-import-check.mjs <directory>   (checks all *.mjs in dir)
 *
 * Negative test (proves the harness works):
 *   ORBITAL_COLD_IMPORT_NEGATIVE=1 node scripts/lambda-cold-import-check.mjs <bundle>
 *   → expects the bundle to throw "intentional negative-test crash"
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'

const arg = process.argv[2] ?? ''
if (!arg) {
  console.error('usage: lambda-cold-import-check.mjs <bundle-path-or-directory>')
  process.exit(2)
}

// Collect bundles to check: either a single .mjs file or all .mjs in a directory.
async function collectBundles(pathArg) {
  const abs = resolve(pathArg)
  const info = await stat(abs).catch(() => null)
  if (!info) {
    console.error(`ERROR: path not found: ${abs}`)
    process.exit(2)
  }
  if (info.isDirectory()) {
    const entries = await readdir(abs)
    const bundles = entries
      .filter((e) => extname(e) === '.mjs')
      .map((e) => join(abs, e))
    if (bundles.length === 0) {
      console.error(`ERROR: no .mjs files found in directory: ${abs}`)
      process.exit(2)
    }
    return bundles
  }
  if (!abs.endsWith('.mjs')) {
    console.error('ERROR: bundle must be a .mjs file or a directory containing .mjs files')
    process.exit(2)
  }
  return [abs]
}

const bundlePaths = await collectBundles(arg)

// Minimal env that Lambda always has (region, function name) — explicitly
// NOT including HOME, USERPROFILE, USER, LOGNAME. Anything beyond this set
// must be injected explicitly by CDK.
const lambdaApproxEnv = {
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_LAMBDA_FUNCTION_NAME: 'cold-import-check',
  AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
  AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '1024',
  AWS_LAMBDA_LOG_GROUP_NAME: '/orbital/test/cold-import',
  AWS_LAMBDA_LOG_STREAM_NAME: 'cold-import-check',
  AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x',
  PATH: '/var/lang/bin:/usr/local/bin:/usr/bin/:/bin',
  ORBITAL_DEPLOY_TARGET: 'aws',
  ORBITAL_ENV: 'mwitt',
  ORBITAL_TENANT_RESOLUTION: 'jwt',
  ORBITAL_HOME: '/tmp/.orbital',
  // Stubs for the env vars CDK injects on the real Lambda.
  // We don't need real values; cold-import must not depend on them being valid.
  RDS_PROXY_HOSTNAME: 'fake.rds-proxy.aws.example',
  RDS_PROXY_PORT: '5432',
  AURORA_DB_NAME: 'orbital_hub',
  AURORA_USERNAME: 'orbital_admin',
  AWS_ACCOUNT_ID: '000000000000',
  COGNITO_USER_POOL_ID: 'us-east-1_XXXXXXXXX',
  COGNITO_APP_CLIENT_ID: 'cold_import_check_client',
  ORBITAL_DB_CREDS_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:fake',
  ORBITAL_HUB_MASTER_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:fake',
  ORBITAL_GITHUB_WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:fake',
  EVENTS_TOPIC_ARN: 'arn:aws:sns:us-east-1:000000000000:fake',
  // Negative-test toggle.
  ORBITAL_COLD_IMPORT_NEGATIVE: process.env.ORBITAL_COLD_IMPORT_NEGATIVE ?? '',
}

/**
 * Check a single bundle. Returns the exit code (0 = pass).
 */
async function checkBundle(bundlePath) {
  const tmp = await mkdtemp(join(tmpdir(), 'cold-import-'))
  const probeFile = join(tmp, 'probe.mjs')

  const probe = `
// Probe — dynamic-imports the target bundle and reports success/failure.
//
// CRITICAL: this script must NOT rely on ANY external state. The Lambda
// runtime calls /var/runtime/index.mjs which dynamic-imports the user
// handler module — exactly what we simulate here.

const target = ${JSON.stringify(bundlePath)}

;(async () => {
  try {
    if (process.env.ORBITAL_COLD_IMPORT_NEGATIVE === '1') {
      throw new Error('intentional negative-test crash')
    }
    const mod = await import('file://' + target)
    if (typeof mod.handler !== 'function') {
      console.error('FAIL: bundle does not export a handler function')
      console.error('     exports:', Object.keys(mod).join(', ') || '(none)')
      process.exit(1)
    }
    console.log('OK: bundle imported clean, handler is a function')
    process.exit(0)
  } catch (err) {
    console.error('FAIL: bundle import threw at module-evaluation time')
    if (err && typeof err === 'object') {
      console.error('     name:    ' + (err.name ?? 'Error'))
      console.error('     message: ' + (err.message ?? ''))
      if (err.stack) {
        console.error('     stack:')
        for (const line of String(err.stack).split('\\n')) {
          console.error('       ' + line)
        }
      }
    } else {
      console.error('     thrown:', err)
    }
    process.exit(1)
  }
})()
`

  await writeFile(probeFile, probe, 'utf8')

  const child = spawn(process.execPath, [probeFile], {
    env: lambdaApproxEnv, // sanitized env
    stdio: 'inherit',
    // Run from /tmp so CWD-relative resolution can't reach the repo
    cwd: tmp,
  })

  const exitCode = await new Promise((res) => child.on('exit', res))
  await rm(tmp, { recursive: true, force: true })
  return exitCode ?? 1
}

// --- Negative-test mode: use the first (only) bundle ---
if (process.env.ORBITAL_COLD_IMPORT_NEGATIVE === '1') {
  const exitCode = await checkBundle(bundlePaths[0])
  if (exitCode === 0) {
    console.error('NEGATIVE-TEST FAIL: bundle imported clean despite ORBITAL_COLD_IMPORT_NEGATIVE=1')
    process.exit(1)
  }
  console.log('NEGATIVE-TEST OK: bundle correctly threw under negative-test condition')
  process.exit(0)
}

// --- Normal mode: check all collected bundles sequentially ---
let anyFailed = false
for (const bp of bundlePaths) {
  console.log(`\n--- checking: ${bp}`)
  const exitCode = await checkBundle(bp)
  if (exitCode !== 0) {
    console.error(`FAIL: ${bp}`)
    anyFailed = true
  }
}

process.exit(anyFailed ? 1 : 0)
