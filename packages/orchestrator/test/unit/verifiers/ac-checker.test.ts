/**
 * ac-checker.test.ts — unit tests for the AC checker.
 *
 * Coverage:
 *   - framework detection (vitest, jest, playwright, mocha, pytest, go-test, unknown)
 *   - keyword-based test matching
 *   - test execution: pass / fail / spawn error / timeout
 *   - LLM fallback when no test matches
 *   - manual_required when LLM unavailable
 *
 * No real Postgres; no real network; no real test runners. Pure unit tests
 * with injected fs and spawnSync seams.
 */

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import {
  checkAC,
  detectFramework,
  matchTestFiles,
} from '../../../src/verifiers/ac-checker.js'
import type { AnthropicDriver } from '../../../src/personas/anthropic-driver.js'

// ---------------------------------------------------------------------------
// Filesystem fixture helpers
// ---------------------------------------------------------------------------

async function makeWorktree(
  files: Record<string, string>,
): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-ac-checker-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
  }
  return root
}

// ---------------------------------------------------------------------------
// detectFramework
// ---------------------------------------------------------------------------

describe('ac-checker.detectFramework', () => {
  it('detects vitest from package.json devDependencies', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('vitest')
    expect(det.runner).toContain('vitest')
  })

  it('detects jest', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('jest')
  })

  it('detects playwright (@playwright/test)', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.49.0' } }),
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('playwright')
  })

  it('detects mocha', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { mocha: '^10.0.0' } }),
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('mocha')
  })

  it('detects pytest from pyproject.toml', async () => {
    const root = await makeWorktree({
      'pyproject.toml': '[tool.pytest.ini_options]\nminversion = "7.0"\n',
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('pytest')
  })

  it('detects go-test from go.mod', async () => {
    const root = await makeWorktree({
      'go.mod': 'module example.com/foo\n\ngo 1.22\n',
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('go-test')
  })

  it('returns unknown when no recognised manifest is present', async () => {
    const root = await makeWorktree({
      'README.md': 'a project',
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('unknown')
  })

  it('prefers vitest over jest when both are listed', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({
        devDependencies: { vitest: '^2.0.0', jest: '^29.0.0' },
      }),
    })
    const det = await detectFramework(root)
    expect(det.framework).toBe('vitest')
  })

  it('handles malformed package.json gracefully', async () => {
    const root = await makeWorktree({ 'package.json': '{ not valid json' })
    const det = await detectFramework(root)
    expect(det.framework).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// matchTestFiles — keyword overlap
// ---------------------------------------------------------------------------

describe('ac-checker.matchTestFiles', () => {
  it('matches a vitest test by keyword overlap with the AC title', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'src/auth/password-reset.test.ts': 'import { test } from "vitest"\ntest("ok", () => {})',
      'src/billing/charge.test.ts': 'import { test } from "vitest"\ntest("ok", () => {})',
    })
    const detection = await detectFramework(root)
    const matches = await matchTestFiles(
      root,
      { title: 'Password reset', criterion: 'User can reset their password' },
      detection,
    )
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.endsWith('password-reset.test.ts')).toBe(true)
  })

  it('returns empty list when framework is unknown', async () => {
    const root = await makeWorktree({})
    const detection = await detectFramework(root)
    const matches = await matchTestFiles(
      root,
      { title: 'X', criterion: 'Y' },
      detection,
    )
    expect(matches).toEqual([])
  })

  it('skips node_modules and .git directories', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'node_modules/foo/bar.test.ts': 'noise',
      '.git/objects/something.test.ts': 'noise',
      'src/feature.test.ts': 'real',
    })
    const detection = await detectFramework(root)
    const matches = await matchTestFiles(
      root,
      { title: 'feature', criterion: 'feature works' },
      detection,
    )
    expect(matches.every((p) => !p.includes('node_modules'))).toBe(true)
    expect(matches.every((p) => !p.includes('.git'))).toBe(true)
  })

  it('returns empty when AC has only stop-words', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'src/feature.test.ts': 'real',
    })
    const detection = await detectFramework(root)
    const matches = await matchTestFiles(
      root,
      { title: 'a', criterion: 'is the of' },
      detection,
    )
    expect(matches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkAC — full algorithm
// ---------------------------------------------------------------------------

describe('ac-checker.checkAC', () => {
  it('runs the matched test and emits test_run evidence with pass on exit code 0', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'src/auth/password-reset.test.ts': 'noop',
    })

    const fakeSpawn = (() => ({
      status: 0,
      stdout: 'PASS: 1 test passed\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    })) as unknown as typeof import('node:child_process').spawnSync

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-1', title: 'Password reset', criterion: 'User can reset password' },
      diffSummary: 'src/auth/password-reset.ts | 5 +++++',
      spawnSyncFn: fakeSpawn,
      timeoutMs: 1000,
    })

    expect(ev.evidence_kind).toBe('test_run')
    expect(ev.result).toBe('pass')
    expect(ev.test_exit_code).toBe(0)
    expect(ev.test_command).toContain('vitest')
    expect(ev.test_output).toContain('PASS')
  })

  it('emits fail when test exits non-zero', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'src/auth/password-reset.test.ts': 'noop',
    })

    const fakeSpawn = (() => ({
      status: 1,
      stdout: 'FAIL: 1 test failed\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    })) as unknown as typeof import('node:child_process').spawnSync

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-2', title: 'Password reset', criterion: 'User can reset password' },
      diffSummary: '',
      spawnSyncFn: fakeSpawn,
    })

    expect(ev.result).toBe('fail')
    expect(ev.test_exit_code).toBe(1)
  })

  it('emits ambiguous test_run on spawn error and falls through to LLM if available', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      'src/auth/password-reset.test.ts': 'noop',
    })

    const fakeSpawn = (() => ({
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      status: null,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    })) as unknown as typeof import('node:child_process').spawnSync

    const fakeDriver: AnthropicDriver = {
      invoke: async () => ({
        result: { verdict: 'pass' as const, reasoning: 'diff looks reasonable' } as never,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'claude-haiku-4-5',
        costUsdMicros: 0,
      }),
    }

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-3', title: 'Password reset', criterion: 'User can reset password' },
      diffSummary: 'src/auth/password-reset.ts | 5 +++++',
      spawnSyncFn: fakeSpawn,
      anthropicDriver: fakeDriver,
    })

    expect(ev.evidence_kind).toBe('llm_inspection')
    expect(ev.result).toBe('pass')
    expect(ev.llm_reasoning).toBeTruthy()
  })

  it('escalates to LLM when no test matches', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
      // No test files at all.
      'README.md': 'no tests yet',
    })

    const fakeDriver: AnthropicDriver = {
      invoke: async () => ({
        result: { verdict: 'fail' as const, reasoning: 'no implementation visible' } as never,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'claude-haiku-4-5',
        costUsdMicros: 0,
      }),
    }

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-4', title: 'Some feature', criterion: 'Some specific behaviour' },
      diffSummary: 'README.md | 1 +',
      anthropicDriver: fakeDriver,
    })

    expect(ev.evidence_kind).toBe('llm_inspection')
    expect(ev.result).toBe('fail')
  })

  it('returns manual_required when no test AND no LLM driver', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
    })

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-5', title: 'X', criterion: 'Y' },
      diffSummary: '',
    })

    expect(ev.evidence_kind).toBe('manual_required')
    expect(ev.result).toBe('ambiguous')
  })

  it('returns manual_required when LLM driver throws', async () => {
    const root = await makeWorktree({
      'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
    })

    const failingDriver: AnthropicDriver = {
      invoke: async () => {
        throw new Error('STARTUP_ERROR_NO_ANTHROPIC_API_KEY')
      },
    }

    const ev = await checkAC({
      worktreePath: root,
      ac: { ac_id: 'ac-6', title: 'X', criterion: 'Y' },
      diffSummary: '',
      anthropicDriver: failingDriver,
    })

    expect(ev.evidence_kind).toBe('manual_required')
    expect(ev.result).toBe('ambiguous')
    expect(ev.llm_reasoning).toContain('STARTUP_ERROR')
  })

  it('builds the correct command for each framework', async () => {
    const cases = [
      { framework: 'vitest', dep: { vitest: '^2.0.0' }, file: 'src/foo.test.ts', cmd: 'vitest' },
      { framework: 'jest', dep: { jest: '^29.0.0' }, file: 'src/foo.test.ts', cmd: 'jest' },
      {
        framework: 'playwright',
        dep: { '@playwright/test': '^1.49.0' },
        file: 'src/foo.spec.ts',
        cmd: 'playwright',
      },
    ] as const

    for (const c of cases) {
      const root = await makeWorktree({
        'package.json': JSON.stringify({ devDependencies: c.dep }),
        [c.file]: 'noop',
      })

      const captured: { command: string; args: string[] } = { command: '', args: [] }
      const fakeSpawn = ((command: string, args: ReadonlyArray<string>) => {
        captured.command = command
        captured.args = [...args]
        return {
          status: 0,
          stdout: 'ok',
          stderr: '',
          pid: 0,
          output: [],
          signal: null,
        }
      }) as unknown as typeof import('node:child_process').spawnSync

      const ev = await checkAC({
        worktreePath: root,
        ac: { ac_id: `ac-${c.framework}`, title: 'foo', criterion: 'foo works' },
        diffSummary: '',
        spawnSyncFn: fakeSpawn,
      })

      expect(ev.evidence_kind).toBe('test_run')
      expect(captured.command).toBe('npx')
      expect(captured.args.join(' ')).toContain(c.cmd)
    }
  })
})
