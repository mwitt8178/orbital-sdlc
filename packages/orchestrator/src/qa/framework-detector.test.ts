/**
 * framework-detector.test.ts — unit tests for detectFramework().
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * RED phase: tests written before implementation.
 *
 * Strategy: we cannot run real `git` against a temp repo in a unit test without
 * external deps. Instead we spy on `execFileP` calls and verify detection logic.
 * The tests exercise the conditional branches without hitting the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// We mock the child_process module so tests don't need a real git repo.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { detectFramework } from './framework-detector.js'

// Helper: build a promisified execFile mock that returns stdout for given args.
type ExecFileMock = ReturnType<typeof vi.fn>

/**
 * Configure the execFile mock to respond to specific git commands.
 * `showMap`: maps "<ref>:<filePath>" → file content string (or null = error)
 * `lsTreeFiles`: files returned by git ls-tree
 */
function setupExecFileMock(
  mock: ExecFileMock,
  showMap: Record<string, string | null>,
  lsTreeFiles: string[],
) {
  mock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const sub = args[0]
      if (sub === 'show') {
        const key = args[1] as string // "ref:path"
        const content = showMap[key]
        if (content === null || content === undefined) {
          callback(new Error(`not found: ${key}`), { stdout: '', stderr: '' })
        } else {
          callback(null, { stdout: content, stderr: '' })
        }
      } else if (sub === 'ls-tree') {
        callback(null, { stdout: lsTreeFiles.join('\n'), stderr: '' })
      } else {
        callback(new Error(`unexpected git command: ${sub}`), { stdout: '', stderr: '' })
      }
    },
  )
}

describe('detectFramework', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects vitest when package.json lists vitest as devDependency', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': JSON.stringify({
          devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' },
        }),
      },
      ['src/index.ts', 'src/__tests__/foo.test.ts'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('typescript')
    expect(result.framework).toBe('vitest')
    expect(result.testFileSuffix).toBe('.test.ts')
    expect(result.testDir).toBe('src/__tests__')
  })

  it('detects vitest and uses __tests__/ root when present', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': JSON.stringify({
          devDependencies: { vitest: '^1.0.0' },
        }),
      },
      ['__tests__/foo.test.ts', 'src/index.ts'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.framework).toBe('vitest')
    expect(result.testDir).toBe('__tests__')
  })

  it('detects jest when package.json lists jest as devDependency', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': JSON.stringify({
          devDependencies: { jest: '^29.0.0' },
        }),
      },
      ['src/__tests__/bar.test.ts'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('typescript')
    expect(result.framework).toBe('jest')
  })

  it('detects pytest when pyproject.toml mentions pytest', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': null,
        'HEAD:pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]',
        'HEAD:pytest.ini': null,
        'HEAD:setup.cfg': null,
      },
      ['tests/test_foo.py', 'src/foo.py'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('python')
    expect(result.framework).toBe('pytest')
    expect(result.testFileSuffix).toBe('_test.py')
    expect(result.testDir).toBe('tests')
  })

  it('detects pytest when pytest.ini is present', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': null,
        'HEAD:pyproject.toml': null,
        'HEAD:pytest.ini': '[pytest]\naddopts = -q',
        'HEAD:setup.cfg': null,
      },
      ['tests/test_service.py'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('python')
    expect(result.framework).toBe('pytest')
  })

  it('detects go_test when go.mod is present', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': null,
        'HEAD:pyproject.toml': null,
        'HEAD:pytest.ini': null,
        'HEAD:setup.cfg': null,
        'HEAD:go.mod': 'module github.com/example/myapp\n\ngo 1.21',
      },
      ['main.go', 'service/user_test.go'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('go')
    expect(result.framework).toBe('go_test')
    expect(result.testFileSuffix).toBe('_test.go')
    expect(result.testDir).toBe('.')
  })

  it('falls back to vitest/typescript when no manifest is found', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': null,
        'HEAD:pyproject.toml': null,
        'HEAD:pytest.ini': null,
        'HEAD:setup.cfg': null,
        'HEAD:go.mod': null,
      },
      [],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.language).toBe('typescript')
    expect(result.framework).toBe('vitest')
  })

  it('returns correct testFilePattern for detected framework', async () => {
    const mock = execFile as unknown as ExecFileMock
    setupExecFileMock(
      mock,
      {
        'HEAD:package.json': JSON.stringify({
          devDependencies: { vitest: '^1.0.0' },
        }),
      },
      ['src/__tests__/example.test.ts'],
    )

    const result = await detectFramework('/fake/repo', 'HEAD')

    expect(result.testFilePattern).toMatch(/\*\*\/\*\.test\.ts/)
  })

  it('uses the provided ref argument when calling git show', async () => {
    const mock = execFile as unknown as ExecFileMock
    const capturedArgs: string[][] = []

    mock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        capturedArgs.push([...args])
        if (args[0] === 'show' && (args[1] as string).startsWith('origin/main:')) {
          if ((args[1] as string).endsWith('package.json')) {
            callback(null, {
              stdout: JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
              stderr: '',
            })
          } else {
            callback(new Error('not found'), { stdout: '', stderr: '' })
          }
        } else if (args[0] === 'ls-tree') {
          callback(null, { stdout: '', stderr: '' })
        } else {
          callback(new Error(`unexpected: ${args.join(' ')}`), { stdout: '', stderr: '' })
        }
      },
    )

    await detectFramework('/fake/repo', 'origin/main')

    const showCalls = capturedArgs.filter((a) => a[0] === 'show')
    expect(showCalls.every((a) => (a[1] as string).startsWith('origin/main:'))).toBe(true)
  })
})
