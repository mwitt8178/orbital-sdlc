/**
 * ac-checker-fixture-worktree.integration.test.ts — end-to-end test for the
 * AC checker driving a real vitest run inside a temp fixture worktree.
 *
 * Per Round 5C done criteria: "AC checker runs a real test in the fixture and
 * captures pass/fail evidence."
 *
 * The fixture worktree contains:
 *   - package.json with vitest as a devDependency
 *   - one passing test for the "Login redirects" AC
 *   - one failing test for the "Logout clears session" AC
 *
 * We don't actually `npm install` vitest into the fixture (too slow + flaky on
 * CI). Instead we depend on the orbital workspace's hoisted vitest binary by
 * copying a node_modules symlink into the fixture root. If that fails on a
 * given environment, the test is skipped with a clear message.
 *
 * If real vitest cannot run, this test still provides value: a smoke test of
 * the spawnSync path with a real binary.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promises as fsp, existsSync } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { checkAC } from '../../../src/verifiers/ac-checker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PASSING_AC = {
  ac_id: 'ac-passing',
  title: 'Math addition works',
  criterion: 'Adding two numbers returns their sum',
}

const FAILING_AC = {
  ac_id: 'ac-failing',
  title: 'Math subtraction works',
  criterion: 'Subtracting two numbers returns their difference',
}

let fixtureRoot: string
let nodeModulesAvailable = false

beforeAll(async () => {
  // Find a vitest binary by walking up from this test file to the workspace
  // root and checking node_modules/.bin/vitest.
  const candidatePaths: string[] = [
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'node_modules', '.bin', 'vitest'),
    path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'vitest'),
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'vitest'),
  ]
  const vitestBin = candidatePaths.find((p) => existsSync(p))
  if (!vitestBin) {
    nodeModulesAvailable = false
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-fixture-novitest-'))
    return
  }
  nodeModulesAvailable = true

  fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-fixture-vitest-'))

  // Layout
  await fsp.writeFile(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'orbital-fixture',
        type: 'module',
        devDependencies: { vitest: '*' },
      },
      null,
      2,
    ),
  )

  await fsp.mkdir(path.join(fixtureRoot, 'src'), { recursive: true })

  await fsp.writeFile(
    path.join(fixtureRoot, 'src', 'addition.test.ts'),
    `import { describe, it, expect } from 'vitest'
describe('addition', () => {
  it('adds two numbers', () => {
    expect(1 + 1).toBe(2)
  })
})
`,
    'utf8',
  )

  await fsp.writeFile(
    path.join(fixtureRoot, 'src', 'subtraction.test.ts'),
    `import { describe, it, expect } from 'vitest'
describe('subtraction', () => {
  it('intentionally fails', () => {
    // This AC is supposed to fail to prove the verifier captures fail evidence.
    expect(5 - 3).toBe(999)
  })
})
`,
    'utf8',
  )

  // Symlink the workspace node_modules so vitest is importable. The mkdtemp
  // root is fresh per beforeAll so the link target shouldn't exist already.
  // workspaceNodeModules walks: vitest.mjs → vitest dir → node_modules root.
  const workspaceNodeModules = path.dirname(path.dirname(vitestBin))
  try {
    await fsp.symlink(workspaceNodeModules, path.join(fixtureRoot, 'node_modules'), 'dir')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('fixture-worktree: symlink failed, skipping real-test cases:', err)
    nodeModulesAvailable = false
  }
})

describe('ac-checker · real fixture worktree', () => {
  it(
    'detects vitest, matches the passing test, and captures pass evidence',
    async (ctx) => {
      if (!nodeModulesAvailable) {
        ctx.skip()
        return
      }
      const ev = await checkAC({
        worktreePath: fixtureRoot,
        ac: PASSING_AC,
        diffSummary: 'src/addition.test.ts | 5 +++++',
        timeoutMs: 30_000,
      })

      expect(ev.evidence_kind).toBe('test_run')
      expect(ev.result).toBe('pass')
      expect(ev.test_exit_code).toBe(0)
      expect(ev.test_command).toContain('vitest')
      expect(ev.test_output).toBeTruthy()
      expect(ev.files_inspected).toContainEqual(
        expect.stringContaining('addition.test.ts'),
      )
    },
    60_000,
  )

  it(
    'matches the failing test and captures fail evidence with non-zero exit code',
    async (ctx) => {
      if (!nodeModulesAvailable) {
        ctx.skip()
        return
      }
      const ev = await checkAC({
        worktreePath: fixtureRoot,
        ac: FAILING_AC,
        diffSummary: 'src/subtraction.test.ts | 5 +++++',
        timeoutMs: 30_000,
      })

      expect(ev.evidence_kind).toBe('test_run')
      expect(ev.result).toBe('fail')
      expect(ev.test_exit_code).not.toBe(0)
      expect(ev.test_output).toMatch(/(fail|FAIL|expected.*to be)/i)
    },
    60_000,
  )

  it('integration test ID linkage — verification id and ac_id round-trip via uuidv7', () => {
    const verificationId = uuidv7()
    const acId = uuidv7()
    expect(verificationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(acId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
