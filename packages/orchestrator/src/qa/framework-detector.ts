/**
 * qa/framework-detector.ts — Sniff a project repo's test language + framework.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Detection order (first match wins):
 *   1. package.json → vitest | jest
 *   2. pyproject.toml / setup.cfg / pytest.ini → pytest
 *   3. go.mod → go_test
 *
 * Returns the language + framework pair that should be used to generate tests.
 * Falls back to { language: 'typescript', framework: 'vitest' } when nothing
 * is detected (matches the project's own dev stack per CLAUDE.md).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../config/logger.js'
import type { TestLanguage, TestFramework } from '../db/schema/story-test-artifacts.js'

const execFileP = promisify(execFile)

export interface DetectedFramework {
  language: TestLanguage
  framework: TestFramework
  testDir: string
  testFilePattern: string
  /** Extension used when generating a new test file, e.g. '.test.ts', '_test.go'. */
  testFileSuffix: string
}

const DEFAULT: DetectedFramework = {
  language: 'typescript',
  framework: 'vitest',
  testDir: 'src/__tests__',
  testFilePattern: '**/*.test.ts',
  testFileSuffix: '.test.ts',
}

/**
 * Read a file from a git repo via `git show <ref>:<path>`.
 * Returns null if the file does not exist on that ref.
 */
async function gitShow(repoDir: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['show', `${ref}:${filePath}`], { cwd: repoDir })
    return stdout
  } catch {
    return null
  }
}

/**
 * List all files on a given ref with `git ls-tree -r --name-only`.
 */
async function gitLsTree(repoDir: string, ref: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: repoDir,
    })
    return stdout.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Detect the test framework used in a git repository.
 *
 * @param repoDir  Local clone directory of the project repo.
 * @param ref      Git ref to inspect (usually the default branch: 'main', 'master').
 */
export async function detectFramework(
  repoDir: string,
  ref = 'HEAD',
): Promise<DetectedFramework> {
  // --- TypeScript / JavaScript via package.json ---
  const packageJson = await gitShow(repoDir, ref, 'package.json')
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as Record<string, unknown>
      const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>
      const deps = (pkg['dependencies'] ?? {}) as Record<string, string>
      const all = { ...deps, ...devDeps }

      if ('vitest' in all) {
        // Prefer __tests__/ if it exists on the ref; fall back to src/__tests__/
        const files = await gitLsTree(repoDir, ref)
        const hasTests = files.some((f) => f.startsWith('__tests__/'))
        const testDir = hasTests ? '__tests__' : 'src/__tests__'
        return {
          language: 'typescript',
          framework: 'vitest',
          testDir,
          testFilePattern: `${testDir}/**/*.test.ts`,
          testFileSuffix: '.test.ts',
        }
      }

      if ('jest' in all) {
        const files = await gitLsTree(repoDir, ref)
        const hasTests = files.some((f) => f.startsWith('__tests__/'))
        const testDir = hasTests ? '__tests__' : 'src/__tests__'
        return {
          language: 'typescript',
          framework: 'jest',
          testDir,
          testFilePattern: `${testDir}/**/*.test.ts`,
          testFileSuffix: '.test.ts',
        }
      }
    } catch (err) {
      logger.warn({ err }, 'framework-detector: could not parse package.json')
    }
  }

  // --- Python via pyproject.toml / pytest.ini / setup.cfg ---
  const pyproject = await gitShow(repoDir, ref, 'pyproject.toml')
  const pytestIni = await gitShow(repoDir, ref, 'pytest.ini')
  const setupCfg = await gitShow(repoDir, ref, 'setup.cfg')
  if (
    pyproject?.includes('pytest') ||
    pytestIni !== null ||
    (setupCfg !== null && setupCfg.includes('[tool:pytest]'))
  ) {
    return {
      language: 'python',
      framework: 'pytest',
      testDir: 'tests',
      testFilePattern: 'tests/**/test_*.py',
      testFileSuffix: '_test.py',
    }
  }

  // --- Go via go.mod ---
  const goMod = await gitShow(repoDir, ref, 'go.mod')
  if (goMod) {
    return {
      language: 'go',
      framework: 'go_test',
      testDir: '.',
      testFilePattern: '**/*_test.go',
      testFileSuffix: '_test.go',
    }
  }

  logger.info({ repoDir, ref }, 'framework-detector: no manifest found; using default (vitest/ts)')
  return DEFAULT
}
