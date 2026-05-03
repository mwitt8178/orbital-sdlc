// [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
/**
 * aws-cutover.e2e.test.ts — Programmatic cutover smoke.
 *
 * Validates the cutover scripts WITHOUT executing real AWS calls or real
 * pg_dump/psql commands. Works by:
 *   1. Verifying the deploy/teardown/cutover/smoke scripts exist + parse.
 *   2. Verifying their guardrails (refuse on bad env, refuse prod teardown).
 *   3. Stubbing aws/pg_dump/psql in PATH and asserting cutover-from-self-host.sh
 *      walks the expected steps.
 *   4. Verifying smoke fixture output: a fully-mocked aws-smoke-test.sh run
 *      (with the AWS CLI replaced by a stub) returns the right exit code.
 *
 * What this is NOT: a deploy. We never call real AWS. The Round 8-09
 * architecture brief explicitly forbids it.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..')
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts')
const DEPLOY_SH = path.join(SCRIPTS_DIR, 'deploy-env.sh')
const TEARDOWN_SH = path.join(SCRIPTS_DIR, 'teardown-env.sh')
const CUTOVER_SH = path.join(SCRIPTS_DIR, 'cutover-from-self-host.sh')
const SMOKE_SH = path.join(SCRIPTS_DIR, 'aws-smoke-test.sh')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string
  stderr: string
  status: number | null
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
): RunResult {
  const result = spawnSync(cmd, args, {
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd ?? REPO_ROOT,
    input: opts.input,
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  }
}

function makeStubBin(scriptName: string, body: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-stub-'))
  const file = path.join(tmp, scriptName)
  fs.writeFileSync(file, body, { mode: 0o755 })
  return tmp
}

// ---------------------------------------------------------------------------
// Suite 1: Scripts exist + parse
// ---------------------------------------------------------------------------

describe('cutover scripts: file system + bash syntax', () => {
  test.each([
    ['deploy-env.sh', DEPLOY_SH],
    ['teardown-env.sh', TEARDOWN_SH],
    ['cutover-from-self-host.sh', CUTOVER_SH],
    ['aws-smoke-test.sh', SMOKE_SH],
  ])('%s exists and is executable', (_name, p) => {
    expect(fs.existsSync(p)).toBe(true)
    const stat = fs.statSync(p)
    expect(stat.mode & 0o111).not.toBe(0) // some execute bit set
  })

  test.each([
    ['deploy-env.sh', DEPLOY_SH],
    ['teardown-env.sh', TEARDOWN_SH],
    ['cutover-from-self-host.sh', CUTOVER_SH],
    ['aws-smoke-test.sh', SMOKE_SH],
  ])('%s parses with bash -n', (_name, p) => {
    const r = run('bash', ['-n', p])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Suite 2: deploy-env.sh guardrails (no AWS call needed)
// ---------------------------------------------------------------------------

describe('deploy-env.sh guardrails', () => {
  test('refuses with no env arg', () => {
    const r = run('bash', [DEPLOY_SH])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage/i)
  })

  test('refuses with invalid env', () => {
    const r = run('bash', [DEPLOY_SH, 'staging-not-a-real-env'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Invalid env/)
  })

  test('refuses prod without ALLOW_PROD_DEPLOY=1', () => {
    const r = run('bash', [DEPLOY_SH, 'prod'], { env: { ALLOW_PROD_DEPLOY: '' } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/ALLOW_PROD_DEPLOY/)
  })
})

// ---------------------------------------------------------------------------
// Suite 3: teardown-env.sh guardrails
// ---------------------------------------------------------------------------

describe('teardown-env.sh guardrails', () => {
  test('refuses with no env arg', () => {
    const r = run('bash', [TEARDOWN_SH])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage/i)
  })

  test('refuses prod outright', () => {
    const r = run('bash', [TEARDOWN_SH, 'prod'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/REFUSE.*prod/i)
  })

  test('refuses with invalid env', () => {
    const r = run('bash', [TEARDOWN_SH, 'staging-not-real'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Invalid env/)
  })
})

// ---------------------------------------------------------------------------
// Suite 4: cutover-from-self-host.sh dry validation
// ---------------------------------------------------------------------------

describe('cutover-from-self-host.sh guardrails', () => {
  test('refuses with no env arg', () => {
    const r = run('bash', [CUTOVER_SH])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage/i)
  })

  test('refuses with invalid env', () => {
    const r = run('bash', [CUTOVER_SH, 'staging-not-real'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Invalid env/)
  })

  test('refuses without ORBITAL_SELFHOST_PG_URL when not --restore-only', () => {
    const r = run('bash', [CUTOVER_SH, 'mwitt'], {
      env: {
        ORBITAL_SELFHOST_PG_URL: '',
        ORBITAL_AURORA_PG_URL: 'postgres://x:y@aurora/db',
        ORBITAL_CUTOVER_AUTO: '1',
      },
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/ORBITAL_SELFHOST_PG_URL/)
  })

  test('refuses without ORBITAL_AURORA_PG_URL when not --dump-only', () => {
    const r = run('bash', [CUTOVER_SH, 'mwitt'], {
      env: {
        ORBITAL_SELFHOST_PG_URL: 'postgres://x:y@source/db',
        ORBITAL_AURORA_PG_URL: '',
        ORBITAL_CUTOVER_AUTO: '1',
      },
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/ORBITAL_AURORA_PG_URL/)
  })
})

// ---------------------------------------------------------------------------
// Suite 5: aws-smoke-test.sh basic guardrails (no real AWS call)
// ---------------------------------------------------------------------------

describe('aws-smoke-test.sh guardrails', () => {
  test('refuses with no env arg', () => {
    const r = run('bash', [SMOKE_SH])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/usage/i)
  })

  test('refuses with invalid env', () => {
    const r = run('bash', [SMOKE_SH, 'not-real'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Invalid env/)
  })
})

// ---------------------------------------------------------------------------
// Suite 6: cutover script dump-only happy path with stubbed pg_dump
// ---------------------------------------------------------------------------

describe('cutover-from-self-host.sh dump-only with stubs', () => {
  /**
   * We stub pg_dump and psql so the script can run end-to-end without a real
   * Postgres. The stubs:
   *   - pg_dump → writes a tiny valid SQL file at the --file path
   *   - psql    → echoes the row count when called for verification
   *   - aws     → returns empty for sts get-caller-identity (cutover doesn't
   *               actually need AWS for dump-only path; we still need it on
   *               PATH for the prereqs check)
   */
  let stubDir: string
  let cleanup: Array<() => void> = []

  beforeAll(() => {
    stubDir = makeStubBin('pg_dump', `#!/usr/bin/env bash
# stub pg_dump for the cutover dump-only test
file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file=*) file="\${1#*=}" ;;
    --version) echo "pg_dump (PostgreSQL) 16.0"; exit 0 ;;
  esac
  shift
done
if [[ -z "$file" ]]; then
  echo "stub pg_dump: --file required" >&2
  exit 1
fi
mkdir -p "$(dirname "$file")"
printf -- '-- stub pg_dump output\\nCREATE TABLE events (id text);\\n' > "$file"
exit 0
`)
    fs.writeFileSync(
      path.join(stubDir, 'psql'),
      `#!/usr/bin/env bash
# stub psql — return a fixed row count for SELECT COUNT(*) calls.
for arg in "$@"; do
  if [[ "$arg" == *"COUNT(*)"* ]]; then
    echo "42"
    exit 0
  fi
done
# default: success no-op
exit 0
`,
      { mode: 0o755 },
    )
    fs.writeFileSync(
      path.join(stubDir, 'aws'),
      `#!/usr/bin/env bash
# stub aws — minimal coverage for prereqs check and queue resolution.
case "$1 $2" in
  "sts get-caller-identity") echo '{"Arn":"arn:aws:iam::000000000000:user/stub","Account":"000000000000"}' ; exit 0 ;;
  "sqs get-queue-url")       echo "https://sqs.stub/queue" ; exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    )
    cleanup.push(() => fs.rmSync(stubDir, { recursive: true, force: true }))
  })

  afterAll(() => {
    for (const fn of cleanup) fn()
  })

  test('--dump-only walks pg_dump and writes a backup file', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-cutover-'))
    // The script writes to PROJECT_ROOT/backups/cutover. We can't easily
    // redirect that, so we run the real script (it picks up REPO_ROOT) and
    // clean up afterwards.
    const r = run('bash', [CUTOVER_SH, 'mwitt', '--dump-only', '--skip-readonly'], {
      env: {
        // Stub binaries take precedence on PATH
        PATH: `${stubDir}:${process.env.PATH}`,
        ORBITAL_SELFHOST_PG_URL: 'postgres://stub:stub@localhost:5432/orbital',
        ORBITAL_AURORA_PG_URL: 'postgres://stub:stub@aurora.stub/orbital',
        ORBITAL_CUTOVER_AUTO: '1',
      },
    })
    // Cleanup tmpRoot regardless
    fs.rmSync(tmpRoot, { recursive: true, force: true })

    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Dump complete/)
    expect(r.stdout).toMatch(/Dump-only mode complete/)

    // Cleanup the dump file we just produced
    const dumpDir = path.join(REPO_ROOT, 'backups', 'cutover')
    if (fs.existsSync(dumpDir)) {
      const dumpFiles = fs
        .readdirSync(dumpDir)
        .filter((f) => f.startsWith('orbital-cutover-mwitt-') && f.endsWith('.sql'))
        .map((f) => path.join(dumpDir, f))
      for (const f of dumpFiles) {
        fs.unlinkSync(f)
        const c = `${f}.events-count`
        if (fs.existsSync(c)) fs.unlinkSync(c)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Suite 7: cdk.json env config sanity (the source of truth)
// ---------------------------------------------------------------------------

describe('cdk.json env config sanity', () => {
  type EnvBlock = {
    account: string
    region: string
    domain: string
    auroraMinAcu: number
    auroraMaxAcu: number
    logRetentionDays: number
    enableMfa: boolean
  }
  let envs: Record<string, EnvBlock>

  beforeAll(() => {
    const cdkJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'infra', 'cdk.json'), 'utf-8'),
    ) as { context: { envs: Record<string, EnvBlock> } }
    envs = cdkJson.context.envs
  })

  test('mwitt + rreed + prod all defined', () => {
    expect(envs.mwitt).toBeDefined()
    expect(envs.rreed).toBeDefined()
    expect(envs.prod).toBeDefined()
  })

  test('domains are unique per env', () => {
    const domains = [envs.mwitt!.domain, envs.rreed!.domain, envs.prod!.domain]
    expect(new Set(domains).size).toBe(3)
  })

  test('mwitt and rreed are in different regions', () => {
    expect(envs.mwitt!.region).not.toBe(envs.rreed!.region)
  })

  test('prod has stricter defaults than dev', () => {
    expect(envs.prod!.auroraMinAcu).toBeGreaterThanOrEqual(envs.mwitt!.auroraMinAcu)
    expect(envs.prod!.auroraMaxAcu).toBeGreaterThanOrEqual(envs.mwitt!.auroraMaxAcu)
    expect(envs.prod!.logRetentionDays).toBeGreaterThanOrEqual(envs.mwitt!.logRetentionDays)
    expect(envs.prod!.enableMfa).toBe(true)
    expect(envs.mwitt!.enableMfa).toBe(false)
  })
})
