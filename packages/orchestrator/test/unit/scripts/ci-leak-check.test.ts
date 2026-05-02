/**
 * test/unit/scripts/ci-leak-check.test.ts
 *
 * Round 7-05 — CI leak-check script.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Feeds the leak-check engine clean and dirty inputs and asserts the
 * expected pass/fail outcome. Uses the engine's pure-function entrypoints
 * (no spawning of `tsx` for unit tests; the real script is exercised via
 * the integration leak-prevention test that pipes a fake change through it).
 */

import { describe, it, expect } from 'vitest'
import {
  scanForKeyLiterals,
  hasUnsafeAsLocalOnlyCast,
  type LeakFinding,
} from '../../../../../scripts/ci-leak-check.js'

// ---------------------------------------------------------------------------
// scanForKeyLiterals
// ---------------------------------------------------------------------------

describe('ci-leak-check / scanForKeyLiterals', () => {
  it('flags Anthropic key literal', () => {
    const findings = scanForKeyLiterals('foo.ts', 'const k = "sk-ant-api03-1234567890abcdef"')
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('anthropic-key-literal')
  })

  it('flags OpenAI key literal', () => {
    const findings = scanForKeyLiterals('foo.ts', 'const k = "sk-proj-1234567890abcdef1234"')
    expect(findings.length).toBeGreaterThan(0)
  })

  it('does NOT flag a benign string', () => {
    const findings = scanForKeyLiterals('foo.ts', 'const x = "hello world"')
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag ANTHROPIC_API_KEY in config files', () => {
    const findings = scanForKeyLiterals('packages/orchestrator/src/config/env.ts', 'ANTHROPIC_API_KEY: z.string().optional()')
    expect(findings).toHaveLength(0)
  })

  it('flags ANTHROPIC_API_KEY usage in non-config file', () => {
    const findings = scanForKeyLiterals('packages/orchestrator/src/foo/handler.ts', 'process.env.ANTHROPIC_API_KEY')
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('anthropic-env-direct-access')
  })

  it('does NOT flag the leak-check script itself', () => {
    // Self-reference exception: scripts/ci-leak-check.ts contains the regex
    // string "sk-ant-" as a literal pattern; we don't want to flag itself.
    const findings = scanForKeyLiterals('scripts/ci-leak-check.ts', 'const RE = /sk-ant-/')
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag the sanitizer source itself', () => {
    const findings = scanForKeyLiterals('packages/orchestrator/src/hub-client/sanitize.ts', 'const ANTHROPIC_KEY_VALUE_RE = /sk-ant-/')
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag test files matching expected literals', () => {
    const findings = scanForKeyLiterals('packages/orchestrator/test/unit/foo.test.ts', '"sk-ant-fake-key-for-test"')
    // Tests are expected to use fake key prefixes; allowed.
    expect(findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// hasUnsafeAsLocalOnlyCast
// ---------------------------------------------------------------------------

describe('ci-leak-check / hasUnsafeAsLocalOnlyCast', () => {
  it('flags `as LocalOnly` cast outside of types/local-only.ts', () => {
    const found = hasUnsafeAsLocalOnlyCast('packages/orchestrator/src/foo/bar.ts', 'return x as LocalOnly<string>')
    expect(found).toHaveLength(1)
  })

  it('does NOT flag `as LocalOnly` in types/local-only.ts', () => {
    const found = hasUnsafeAsLocalOnlyCast('packages/orchestrator/src/types/local-only.ts', 'return v as LocalOnly<T>')
    expect(found).toHaveLength(0)
  })

  it('does NOT flag normal code without the cast', () => {
    const found = hasUnsafeAsLocalOnlyCast('packages/orchestrator/src/foo.ts', 'const x = 1')
    expect(found).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Engine integration: deliberately broken file
// ---------------------------------------------------------------------------

describe('ci-leak-check / engine end-to-end', () => {
  it('produces a non-empty finding list for a deliberately broken hub-client call', async () => {
    // Simulate a developer adding a leak: a string literal containing an
    // Anthropic key prefix being assigned somewhere.
    const dirtyContent = `
      // Pretend this is a hub call body
      const body = { payload: { key: "sk-ant-api03-leak-1234567890" } }
      hubClient.events.append(body)
    `
    const findings: LeakFinding[] = scanForKeyLiterals(
      'packages/orchestrator/src/some/router.ts',
      dirtyContent,
    )
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toBe('anthropic-key-literal')
  })
})
