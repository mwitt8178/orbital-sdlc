/**
 * verifiers/ac-checker.ts — the core AC-checking algorithm.
 *
 * Per Round 5C spec and architecture.md.
 *
 * Algorithm:
 *   1. Detect test framework by scanning package.json for known runners
 *      (vitest, jest, playwright, mocha, go test, pytest).
 *   2. Match candidate test files by keyword overlap with the AC text.
 *   3. If a test file matches → run the framework with the matched path.
 *      Capture stdout+stderr + exit code. evidence_kind='test_run'.
 *      result = 'pass' if exit_code === 0, 'fail' if non-zero, 'ambiguous' on
 *      timeout / spawn error.
 *   4. If no test matches OR the test result is ambiguous, escalate to the
 *      AnthropicDriver with (diff + ac.text + test_output) and ask for a
 *      pass/fail/ambiguous verdict. evidence_kind='llm_inspection'.
 *   5. If the LLM driver is unavailable (no key) AND no test matched, return
 *      evidence_kind='manual_required', result='ambiguous'.
 *
 * The algorithm is deterministic given (worktree contents, AC text, driver
 * availability). The LLM call is the only non-deterministic step; its output
 * is captured verbatim in `llm_reasoning` for audit replay.
 *
 * Security:
 *   - We never compose a shell command from user-supplied AC text. The test
 *     command is built from the framework metadata and a candidate test path
 *     that exists on disk.
 *   - spawnSync is invoked with an arg array (never a shell) and a timeout.
 *   - cwd is locked to the verifier worktree.
 */

import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AnthropicDriver } from '../personas/anthropic-driver.js'
import { logger } from '../config/logger.js'
import type { ACCheckEvidence } from './evidence.js'
import { mergeCIEvidenceWithLocal, type MergeableCIEvidence } from './ci-evidence.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'playwright'
  | 'mocha'
  | 'pytest'
  | 'go-test'
  | 'unknown'

export interface FrameworkDetection {
  framework: TestFramework
  /** Optional hint about how the runner is invoked (e.g. "npx vitest run"). */
  runner: string | null
  /** Optional: how to discover test files (file glob). */
  testGlob: string | null
}

export interface ACCheckerInput {
  /** Absolute path to the verifier worktree. */
  worktreePath: string
  /** The AC being checked. */
  ac: { ac_id: string; title: string; criterion: string }
  /** A short summary of the diff (typically `git diff --stat` output). */
  diffSummary: string
  /** Optional Anthropic driver for LLM fallback. */
  anthropicDriver?: AnthropicDriver
  /** Per-call wall-clock timeout for the spawned test process. */
  timeoutMs?: number
  /** Test seam: override the worktree filesystem read. */
  fsRead?: typeof fsp
  /** Test seam: override child_process.spawnSync. */
  spawnSyncFn?: typeof spawnSync
  /**
   * Round 6 #6: CI run evidence from check_run webhook.
   * When present, the verifier applies CI evidence precedence:
   *   - CI fail overrides local pass (fail-closed).
   *   - CI pass + local pass → both recorded; primary=ci_run.
   *   - No CI evidence → local test_run is used as before.
   * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
   */
  ciEvidence?: MergeableCIEvidence | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Stop-words removed before keyword matching. These are too generic to be
 * useful as test-file matchers and would produce false positives on every AC.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'should',
  'shows',
  'that',
  'the',
  'this',
  'to',
  'when',
  'with',
  'will',
  'must',
  'user',
  'users',
  'shown',
  'can',
])

const MAX_TEST_OUTPUT_BYTES = 32_000 // truncate captured output for storage

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the AC-check algorithm against the worktree and return evidence.
 *
 * Always returns a populated ACCheckEvidence. Never throws on test failure
 * (test failure is the verdict, not an error). Throws only on programmer
 * error (invalid worktree path, malformed AC).
 */
export async function checkAC(input: ACCheckerInput): Promise<ACCheckEvidence> {
  const fs = input.fsRead ?? fsp
  const sp = input.spawnSyncFn ?? spawnSync
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // 1. Detect framework
  const detection = await detectFramework(input.worktreePath, fs)
  logger.debug(
    { worktreePath: input.worktreePath, framework: detection.framework },
    'ac-checker: framework detected',
  )

  // 2. Match candidate test files by keyword overlap with the AC text
  const candidatePaths = await matchTestFiles(input.worktreePath, input.ac, detection, fs)
  logger.debug(
    { acId: input.ac.ac_id, matched: candidatePaths.length, candidatePaths },
    'ac-checker: candidate tests matched',
  )

  // 3. If we have at least one candidate AND a known framework, run it
  if (candidatePaths.length > 0 && detection.framework !== 'unknown') {
    const runEvidence = runTest({
      framework: detection.framework,
      runner: detection.runner,
      worktreePath: input.worktreePath,
      testPath: candidatePaths[0]!,
      timeoutMs,
      ac: input.ac,
      spawnSyncFn: sp,
      filesInspected: candidatePaths,
    })

    // 3a. Apply CI evidence precedence if CI evidence is available.
    // Round 6 #6: ci_run evidence overrides local test_run (fail-closed).
    // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
    if (input.ciEvidence && runEvidence.result !== 'ambiguous') {
      const mergeResult = mergeCIEvidenceWithLocal(
        {
          ac_id: runEvidence.ac_id,
          ac_title: runEvidence.ac_title,
          result: runEvidence.result,
          evidence_kind: runEvidence.evidence_kind as 'test_run',
          test_command: runEvidence.test_command,
          test_output: runEvidence.test_output,
          test_exit_code: runEvidence.test_exit_code,
          files_inspected: runEvidence.files_inspected,
        },
        input.ciEvidence,
      )

      if (mergeResult.mismatch) {
        logger.warn(
          {
            acId: input.ac.ac_id,
            localResult: runEvidence.result,
            ciConclusion: input.ciEvidence.ci_conclusion,
          },
          'ac-checker: CI FAIL overrides local PASS (fail-closed); mismatch logged for operator review',
        )
      }

      return {
        ac_id: mergeResult.primary.ac_id,
        ac_title: mergeResult.primary.ac_title,
        result: mergeResult.primary.result,
        evidence_kind: mergeResult.primary.evidence_kind,
        test_command: runEvidence.test_command,
        test_output: runEvidence.test_output,
        test_exit_code: runEvidence.test_exit_code,
        ci_run_url: mergeResult.primary.ci_run_url,
        ci_check_name: mergeResult.primary.ci_check_name,
        ci_conclusion: mergeResult.primary.ci_conclusion,
        files_inspected: mergeResult.primary.files_inspected,
      }
    }

    // 4a. If unambiguous, return.
    if (runEvidence.result !== 'ambiguous') {
      return runEvidence
    }

    // 4b. If ambiguous (timeout / spawn error), fall through to LLM if available
    if (input.anthropicDriver) {
      const llmEvidence = await llmInspect({
        ac: input.ac,
        diffSummary: input.diffSummary,
        testOutput: runEvidence.test_output ?? '',
        anthropicDriver: input.anthropicDriver,
        filesInspected: candidatePaths,
      })
      return llmEvidence
    }

    return runEvidence
  }

  // 5. No candidate test or unknown framework — check CI evidence first
  // Round 6 #6: if CI evidence available, prefer it over LLM.
  // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
  if (input.ciEvidence) {
    const mergeResult = mergeCIEvidenceWithLocal(null, input.ciEvidence)
    return {
      ac_id: mergeResult.primary.ac_id,
      ac_title: mergeResult.primary.ac_title,
      result: mergeResult.primary.result,
      evidence_kind: 'ci_run',
      ci_run_url: mergeResult.primary.ci_run_url,
      ci_check_name: mergeResult.primary.ci_check_name,
      ci_conclusion: mergeResult.primary.ci_conclusion,
      files_inspected: mergeResult.primary.files_inspected ?? candidatePaths,
    }
  }

  // 6. Try LLM, then fall back to manual
  if (input.anthropicDriver) {
    const llmEvidence = await llmInspect({
      ac: input.ac,
      diffSummary: input.diffSummary,
      testOutput: '',
      anthropicDriver: input.anthropicDriver,
      filesInspected: candidatePaths,
    })
    return llmEvidence
  }

  return {
    ac_id: input.ac.ac_id,
    ac_title: input.ac.title,
    result: 'ambiguous',
    evidence_kind: 'manual_required',
    files_inspected: candidatePaths,
  }
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

/**
 * Detect the test framework by scanning package.json (and a couple of
 * sibling files). Sophisticated detection (running `npx vitest --version`
 * etc.) is deferred per the brief.
 */
export async function detectFramework(
  worktreePath: string,
  fs: typeof fsp = fsp,
): Promise<FrameworkDetection> {
  // 1. Try Node.js package.json
  try {
    const pkgPath = path.join(worktreePath, 'package.json')
    const raw = await fs.readFile(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (deps['vitest']) {
      return { framework: 'vitest', runner: 'npx vitest run', testGlob: '**/*.test.{ts,tsx,js,jsx}' }
    }
    if (deps['playwright'] || deps['@playwright/test']) {
      return {
        framework: 'playwright',
        runner: 'npx playwright test',
        testGlob: '**/*.spec.{ts,tsx,js,jsx}',
      }
    }
    if (deps['jest']) {
      return { framework: 'jest', runner: 'npx jest', testGlob: '**/*.test.{ts,tsx,js,jsx}' }
    }
    if (deps['mocha']) {
      return { framework: 'mocha', runner: 'npx mocha', testGlob: '**/test/**/*.{ts,js}' }
    }
  } catch {
    // No package.json or parse error — keep going.
  }

  // 2. Python — pytest
  try {
    const pyprojectPath = path.join(worktreePath, 'pyproject.toml')
    const raw = await fs.readFile(pyprojectPath, 'utf8')
    if (raw.includes('pytest')) {
      return { framework: 'pytest', runner: 'pytest', testGlob: '**/test_*.py' }
    }
  } catch {
    // Continue
  }

  // 3. Go — go.mod present
  try {
    const goModPath = path.join(worktreePath, 'go.mod')
    await fs.stat(goModPath)
    return { framework: 'go-test', runner: 'go test', testGlob: '**/*_test.go' }
  } catch {
    // Continue
  }

  return { framework: 'unknown', runner: null, testGlob: null }
}

// ---------------------------------------------------------------------------
// Test-file matching
// ---------------------------------------------------------------------------

/**
 * Find test files in the worktree whose names share at least one non-stop-word
 * keyword with the AC text. Returns absolute paths sorted by descending
 * keyword overlap.
 *
 * Simple keyword overlap is intentional. A v2 might score by AST analysis or
 * embeddings; v1 is "looks-like-the-AC".
 */
export async function matchTestFiles(
  worktreePath: string,
  ac: { title: string; criterion: string },
  detection: FrameworkDetection,
  fs: typeof fsp = fsp,
): Promise<string[]> {
  if (detection.framework === 'unknown' || !detection.testGlob) return []

  const acText = `${ac.title} ${ac.criterion}`.toLowerCase()
  const acKeywords = new Set(extractKeywords(acText))
  if (acKeywords.size === 0) return []

  // Walk the worktree (skipping common ignore dirs) and collect test files.
  const testFiles = await walkForTestFiles(worktreePath, detection, fs)

  // Score each file by keyword overlap.
  const scored: Array<{ path: string; score: number }> = []
  for (const file of testFiles) {
    const stem = path.basename(file).toLowerCase()
    const fileTokens = new Set(extractKeywords(stem))
    let score = 0
    for (const kw of acKeywords) {
      if (fileTokens.has(kw)) score += 1
      else if ([...fileTokens].some((t) => t.includes(kw) || kw.includes(t))) score += 0.5
    }
    if (score > 0) scored.push({ path: file, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 5).map((s) => s.path)
}

function extractKeywords(text: string): string[] {
  return text
    .replace(/[^a-z0-9-_\s]/gi, ' ')
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok))
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

async function walkForTestFiles(
  root: string,
  detection: FrameworkDetection,
  fs: typeof fsp,
): Promise<string[]> {
  const found: string[] = []
  const isMatch = makeFrameworkMatcher(detection.framework)
  await walk(root, found, isMatch, fs, 0)
  return found
}

async function walk(
  dir: string,
  accumulator: string[],
  isMatch: (filename: string) => boolean,
  fs: typeof fsp,
  depth: number,
): Promise<void> {
  if (depth > 8) return // sanity bound
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(path.join(dir, entry.name), accumulator, isMatch, fs, depth + 1)
    } else if (entry.isFile()) {
      if (isMatch(entry.name)) {
        accumulator.push(path.join(dir, entry.name))
      }
    }
  }
}

function makeFrameworkMatcher(framework: TestFramework): (filename: string) => boolean {
  switch (framework) {
    case 'vitest':
    case 'jest':
      return (n) => /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(n)
    case 'playwright':
      return (n) => /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(n)
    case 'mocha':
      return (n) => /\.(test|spec)\.(ts|js)$/i.test(n)
    case 'pytest':
      return (n) => /^test_.*\.py$/i.test(n) || /_test\.py$/i.test(n)
    case 'go-test':
      return (n) => /_test\.go$/i.test(n)
    case 'unknown':
    default:
      return () => false
  }
}

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

interface RunTestParams {
  framework: TestFramework
  runner: string | null
  worktreePath: string
  testPath: string
  timeoutMs: number
  ac: { ac_id: string; title: string; criterion: string }
  spawnSyncFn: typeof spawnSync
  filesInspected: string[]
}

function runTest(params: RunTestParams): ACCheckEvidence {
  const { command, args } = buildCommand(params.framework, params.runner, params.testPath, params.worktreePath)
  if (!command) {
    return {
      ac_id: params.ac.ac_id,
      ac_title: params.ac.title,
      result: 'ambiguous',
      evidence_kind: 'test_run',
      test_command: `(unsupported framework: ${params.framework})`,
      files_inspected: params.filesInspected,
    }
  }

  const fullCommand = `${command} ${args.join(' ')}`
  let result: ACCheckEvidence

  try {
    const sp = params.spawnSyncFn(command, args, {
      cwd: params.worktreePath,
      timeout: params.timeoutMs,
      encoding: 'utf8',
      // Critical: do NOT use { shell: true } — we want arg-array semantics so
      // shell metacharacters in test paths (unlikely but possible) cannot be
      // interpreted as commands.
      shell: false,
      maxBuffer: 4 * MAX_TEST_OUTPUT_BYTES,
    })

    if (sp.error) {
      // Spawn-level error: command not found, timeout (signal=SIGTERM), etc.
      const errMessage = sp.error.message
      result = {
        ac_id: params.ac.ac_id,
        ac_title: params.ac.title,
        result: 'ambiguous',
        evidence_kind: 'test_run',
        test_command: fullCommand,
        test_output: truncate(`(spawn error) ${errMessage}\n${(sp.stderr ?? '').toString()}`),
        files_inspected: params.filesInspected,
      }
    } else {
      const exitCode = sp.status ?? -1
      const stdout = (sp.stdout ?? '').toString()
      const stderr = (sp.stderr ?? '').toString()
      const combined = truncate(`${stdout}\n${stderr}`.trim())
      result = {
        ac_id: params.ac.ac_id,
        ac_title: params.ac.title,
        result: exitCode === 0 ? 'pass' : 'fail',
        evidence_kind: 'test_run',
        test_command: fullCommand,
        test_output: combined,
        test_exit_code: exitCode,
        files_inspected: params.filesInspected,
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    result = {
      ac_id: params.ac.ac_id,
      ac_title: params.ac.title,
      result: 'ambiguous',
      evidence_kind: 'test_run',
      test_command: fullCommand,
      test_output: truncate(`(spawn threw) ${message}`),
      files_inspected: params.filesInspected,
    }
  }

  return result
}

function buildCommand(
  framework: TestFramework,
  _runner: string | null,
  testPath: string,
  worktreePath: string,
): { command: string | null; args: string[] } {
  // testPath may be absolute; pass relative-to-worktree to keep output stable.
  const relPath = testPath.startsWith(worktreePath)
    ? path.relative(worktreePath, testPath)
    : testPath

  switch (framework) {
    case 'vitest':
      return { command: 'npx', args: ['vitest', 'run', '--reporter=verbose', relPath] }
    case 'jest':
      return { command: 'npx', args: ['jest', '--colors=false', relPath] }
    case 'playwright':
      return { command: 'npx', args: ['playwright', 'test', '--reporter=list', relPath] }
    case 'mocha':
      return { command: 'npx', args: ['mocha', '--reporter=spec', relPath] }
    case 'pytest':
      return { command: 'pytest', args: ['-q', relPath] }
    case 'go-test':
      // Convert path/to/foo_test.go → package "./path/to"
      return { command: 'go', args: ['test', '-v', `./${path.dirname(relPath)}/...`] }
    case 'unknown':
    default:
      return { command: null, args: [] }
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_TEST_OUTPUT_BYTES) return s
  return `${s.slice(0, MAX_TEST_OUTPUT_BYTES)}\n…[truncated to ${MAX_TEST_OUTPUT_BYTES} bytes]`
}

// ---------------------------------------------------------------------------
// LLM inspection fallback
// ---------------------------------------------------------------------------

interface LLMInspectParams {
  ac: { ac_id: string; title: string; criterion: string }
  diffSummary: string
  testOutput: string
  anthropicDriver: AnthropicDriver
  filesInspected: string[]
}

const VerifierLLMResponseSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'ambiguous']),
  reasoning: z.string().min(1),
})

const VERIFIER_SYSTEM_PROMPT = `You are an Acceptance Criterion Verifier.
You judge whether a code change satisfies a single acceptance criterion.

Output exactly one structured verdict:
- "pass" if the diff and test output clearly demonstrate the AC is met
- "fail" if they clearly demonstrate the AC is not met
- "ambiguous" if you cannot decide from the evidence alone

You do not propose fixes. You do not modify the artifact. Cite specific lines
or test output excerpts in your reasoning.`

async function llmInspect(params: LLMInspectParams): Promise<ACCheckEvidence> {
  const userPrompt = [
    `# Acceptance Criterion`,
    ``,
    `**Title:** ${params.ac.title}`,
    `**Criterion:** ${params.ac.criterion}`,
    ``,
    `# Diff Summary`,
    ``,
    '```',
    params.diffSummary || '(no diff captured)',
    '```',
    ``,
    `# Test Output (if any)`,
    ``,
    '```',
    params.testOutput || '(no test was run for this AC)',
    '```',
    ``,
    `Decide: pass / fail / ambiguous, and explain.`,
  ].join('\n')

  try {
    const response = await params.anthropicDriver.invoke({
      persona: 'verifier',
      riskClass: 'standard',
      sessionId: `verifier-llm-${params.ac.ac_id}`,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userPrompt,
      responseSchema: VerifierLLMResponseSchema,
      maxTokens: 1024,
    })

    return {
      ac_id: params.ac.ac_id,
      ac_title: params.ac.title,
      result: response.result.verdict,
      evidence_kind: 'llm_inspection',
      llm_reasoning: response.result.reasoning,
      ...(params.testOutput ? { test_output: truncate(params.testOutput) } : {}),
      files_inspected: params.filesInspected,
    }
  } catch (err: unknown) {
    // LLM driver unavailable or threw — fall through to manual_required so the
    // verifier still emits a valid evidence row.
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(
      { acId: params.ac.ac_id, err: message },
      'ac-checker: LLM inspection failed, returning manual_required',
    )
    return {
      ac_id: params.ac.ac_id,
      ac_title: params.ac.title,
      result: 'ambiguous',
      evidence_kind: 'manual_required',
      llm_reasoning: `LLM inspection unavailable: ${message}`,
      files_inspected: params.filesInspected,
    }
  }
}
