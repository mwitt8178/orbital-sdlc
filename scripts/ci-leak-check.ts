#!/usr/bin/env tsx
/**
 * scripts/ci-leak-check.ts — Static-analysis leak detector for CI.
 *
 * Round 7-05 — Local-Only Concerns Isolation
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Two checks, both run on every PR:
 *
 *   1. KEY-LITERAL SCAN
 *      Greps the codebase for sensitive literal patterns:
 *        - sk-ant- followed by 8+ chars (Anthropic API key prefix)
 *        - sk-proj- / sk-svcacct- / sk- followed by 16+ chars (OpenAI)
 *        - direct process.env.ANTHROPIC_API_KEY access outside the env config
 *      Allow-list:
 *        - this script itself
 *        - the sanitiser source
 *        - test files (which use fake keys deliberately)
 *        - documentation under .claude/, docs/
 *
 *   2. UNSAFE-CAST SCAN
 *      Greps for `as LocalOnly<` casts outside of types/local-only.ts. Such
 *      casts subvert the type system without going through the localOnly()
 *      factory — they should be reviewed and blessed explicitly.
 *
 * Exit codes:
 *   - 0 — clean.
 *   - 1 — findings present; PR cannot merge.
 *
 * Usage in CI: see .github/workflows/ci.yml. Local invocation:
 *   npx tsx scripts/ci-leak-check.ts
 */

import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Public types (used by tests)
// ---------------------------------------------------------------------------

export type LeakKind =
  | 'anthropic-key-literal'
  | 'openai-key-literal'
  | 'anthropic-env-direct-access'
  | 'unsafe-as-local-only'

export interface LeakFinding {
  file: string
  line: number
  kind: LeakKind
  excerpt: string
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g
// More specific OpenAI patterns to avoid false positives.
const OPENAI_KEY_RE = /\bsk-(?:proj|svcacct|api|live|test)-[A-Za-z0-9]{16,}/g
const ANTHROPIC_ENV_DIRECT_RE = /process\.env(?:\.|\[['"])ANTHROPIC_API_KEY/g
const AS_LOCAL_ONLY_RE = /\bas\s+LocalOnly</g

// ---------------------------------------------------------------------------
// Allow-list: which files are exempt from each rule
// ---------------------------------------------------------------------------

/**
 * Files and directories that may legitimately contain sensitive-looking
 * literal patterns. The leak-check engine MUST NOT report findings on these
 * paths or the script will perpetually fail on its own source.
 */
const KEY_LITERAL_ALLOWLIST = [
  // The leak-check script itself
  'scripts/ci-leak-check.ts',
  // The runtime sanitiser whose regexes legitimately mention prefixes
  'packages/orchestrator/src/hub-client/sanitize.ts',
  // Tests use fake key prefixes by design
  '/test/',
  '__fixtures__',
  // Documentation
  '/.claude/',
  '/docs/',
]

/**
 * Files allowed to read process.env.ANTHROPIC_API_KEY directly.
 * Everywhere else must go through the typed env loader.
 *
 * scripts/ are operational scripts (smoke tests, bootstrap, restore) that
 * must read env directly because they run before the typed loader is
 * available; we trust them since they don't produce hub payloads.
 */
const ANTHROPIC_ENV_DIRECT_ALLOWLIST = [
  'packages/orchestrator/src/config/env.ts',
  'packages/orchestrator/src/config/install.ts',
  '/scripts/',
]

/**
 * Files allowed to use `as LocalOnly<...>` casts. The factory function
 * `localOnly()` is the canonical way to brand a value; explicit casts
 * elsewhere bypass review.
 */
const AS_LOCAL_ONLY_ALLOWLIST = [
  'packages/orchestrator/src/types/local-only.ts',
  // The leak-check script itself documents the pattern in comments.
  'scripts/ci-leak-check.ts',
  // Tests deliberately exercise the unsafe pattern to verify detection.
  '/test/',
]

// ---------------------------------------------------------------------------
// Scanning primitives (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Scan a single file's content for sensitive literal patterns.
 *
 * @param relPath  Path RELATIVE to the repo root (so allow-list checks work).
 * @param content  The file body.
 */
export function scanForKeyLiterals(relPath: string, content: string): LeakFinding[] {
  if (matchesAllowlist(relPath, KEY_LITERAL_ALLOWLIST)) return []

  const findings: LeakFinding[] = []
  const lines = content.split('\n')

  lines.forEach((line, idx) => {
    if (ANTHROPIC_KEY_RE.test(line)) {
      findings.push({
        file: relPath,
        line: idx + 1,
        kind: 'anthropic-key-literal',
        excerpt: line.trim().slice(0, 200),
      })
    }
    ANTHROPIC_KEY_RE.lastIndex = 0

    if (OPENAI_KEY_RE.test(line)) {
      findings.push({
        file: relPath,
        line: idx + 1,
        kind: 'openai-key-literal',
        excerpt: line.trim().slice(0, 200),
      })
    }
    OPENAI_KEY_RE.lastIndex = 0
  })

  // ANTHROPIC_API_KEY direct env access — separate allow-list for config.
  if (!matchesAllowlist(relPath, ANTHROPIC_ENV_DIRECT_ALLOWLIST)) {
    lines.forEach((line, idx) => {
      if (ANTHROPIC_ENV_DIRECT_RE.test(line)) {
        findings.push({
          file: relPath,
          line: idx + 1,
          kind: 'anthropic-env-direct-access',
          excerpt: line.trim().slice(0, 200),
        })
      }
      ANTHROPIC_ENV_DIRECT_RE.lastIndex = 0
    })
  }

  return findings
}

/**
 * Detect `as LocalOnly<...>` casts outside of the canonical brand factory.
 */
export function hasUnsafeAsLocalOnlyCast(relPath: string, content: string): LeakFinding[] {
  if (matchesAllowlist(relPath, AS_LOCAL_ONLY_ALLOWLIST)) return []

  const findings: LeakFinding[] = []
  const lines = content.split('\n')
  lines.forEach((line, idx) => {
    if (AS_LOCAL_ONLY_RE.test(line)) {
      findings.push({
        file: relPath,
        line: idx + 1,
        kind: 'unsafe-as-local-only',
        excerpt: line.trim().slice(0, 200),
      })
    }
    AS_LOCAL_ONLY_RE.lastIndex = 0
  })
  return findings
}

// ---------------------------------------------------------------------------
// Allowlist matcher
// ---------------------------------------------------------------------------

function matchesAllowlist(relPath: string, allowlist: string[]): boolean {
  // Normalise to forward slashes regardless of OS for portability.
  // Prefix with '/' so substring entries like '/scripts/' match relative paths
  // that begin with `scripts/`.
  const normalised = '/' + relPath.replace(/\\/g, '/')
  return allowlist.some((entry) => {
    if (entry.startsWith('/')) {
      // Substring match (e.g. /test/ to mean "anywhere with /test/ in it")
      return normalised.includes(entry)
    }
    // Otherwise: exact-prefix match.
    const stripped = normalised.slice(1)
    return stripped === entry || stripped.startsWith(entry + '/')
  })
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * Directories we never descend into. These contain generated, vendored, or
 * locale-specific content that would noise findings.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.git',
  'public',
  '.husky',
  '.claude',
])

function* walkFiles(root: string): Generator<string> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        stack.push(full)
      } else if (stat.isFile()) {
        const dotIdx = name.lastIndexOf('.')
        if (dotIdx === -1) continue
        const ext = name.slice(dotIdx)
        if (!SCAN_EXTENSIONS.has(ext)) continue
        yield full
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine entrypoint
// ---------------------------------------------------------------------------

export interface LeakCheckResult {
  totalFindings: number
  findings: LeakFinding[]
  filesScanned: number
}

export function runLeakCheck(repoRoot: string): LeakCheckResult {
  const all: LeakFinding[] = []
  let filesScanned = 0

  for (const file of walkFiles(repoRoot)) {
    filesScanned += 1
    const rel = relative(repoRoot, file).replace(/\\/g, '/')
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    all.push(...scanForKeyLiterals(rel, content))
    all.push(...hasUnsafeAsLocalOnlyCast(rel, content))
  }

  return {
    totalFindings: all.length,
    findings: all,
    filesScanned,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  // ESM-friendly main check: argv[1] is the entry script's resolved path.
  // process.argv[1] may end with .ts when run via tsx, so we check by
  // file basename.
  const entry = process.argv[1] ?? ''
  return entry.endsWith('ci-leak-check.ts') || entry.endsWith('ci-leak-check.js')
}

function printResultAndExit(result: LeakCheckResult): never {
  /* eslint-disable no-console */
  if (result.totalFindings === 0) {
    console.log(`[ci-leak-check] OK — scanned ${result.filesScanned} files, no findings.`)
    process.exit(0)
  }

  console.error(`[ci-leak-check] FAIL — ${result.totalFindings} finding(s) across ${result.filesScanned} files:`)
  for (const f of result.findings) {
    console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.excerpt}`)
  }
  console.error(``)
  console.error(`Local-only data must not flow to the hub. See:`)
  console.error(`  packages/orchestrator/src/types/local-only.ts`)
  console.error(`  packages/orchestrator/src/hub-client/sanitize.ts`)
  console.error(`  .claude/tasks/round7-05-local-only-isolation/architecture.md`)
  process.exit(1)
  /* eslint-enable no-console */
}

if (isMainModule()) {
  const root = resolve(process.argv[2] ?? process.cwd())
  const result = runLeakCheck(root)
  printResultAndExit(result)
}
