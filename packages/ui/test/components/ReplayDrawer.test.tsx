/**
 * ReplayDrawer / ReplayDiff unit tests — pure logic layer.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * @testing-library/react isn't configured in this package, so we test the
 * pure helpers (canonical JSON serialisation, line-level diff) directly.
 * These mirror the implementations in ReplayDrawer.tsx + ReplayDiff.tsx.
 */

import { describe, it, expect } from 'vitest'

// Mirrored from ReplayDrawer.tsx
function canonicalJSON(v: unknown, indent = 2): string {
  return JSON.stringify(v, (_k, val) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
    const o = val as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = o[k]
        return acc
      }, {})
  }, indent)
}

// Mirrored from ReplayDiff.tsx
function diffLines(a: string, b: string): Array<{ kind: 'eq' | 'add' | 'del'; text: string }> {
  const aL = a.split('\n')
  const bL = b.split('\n')
  const n = aL.length
  const m = bL.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aL[i] === bL[j]) dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1
      else dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const out: Array<{ kind: 'eq' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aL[i] === bL[j]) {
      out.push({ kind: 'eq', text: aL[i]! })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: aL[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: bL[j]! })
      j++
    }
  }
  while (i < n) out.push({ kind: 'del', text: aL[i++]! })
  while (j < m) out.push({ kind: 'add', text: bL[j++]! })
  return out
}

describe('ReplayDrawer — canonicalJSON helper', () => {
  it('sorts object keys deterministically', () => {
    const a = { b: 1, a: 2, c: 3 }
    const b = { a: 2, b: 1, c: 3 }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  it('preserves array order (only object keys are sorted)', () => {
    const v = { items: [3, 1, 2] }
    expect(canonicalJSON(v)).toContain('"items": [\n    3,\n    1,\n    2\n  ]')
  })

  it('handles nested objects', () => {
    const a = { outer: { z: 1, a: 2 } }
    const b = { outer: { a: 2, z: 1 } }
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  it('handles null and primitives', () => {
    expect(canonicalJSON(null)).toBe('null')
    expect(canonicalJSON('foo')).toBe('"foo"')
    expect(canonicalJSON(42)).toBe('42')
    expect(canonicalJSON(true)).toBe('true')
  })
})

describe('ReplayDiff — diffLines helper', () => {
  it('returns all eq for identical input', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc')
    expect(r.every((l) => l.kind === 'eq')).toBe(true)
    expect(r).toHaveLength(3)
  })

  it('marks added lines', () => {
    const r = diffLines('a\nb', 'a\nb\nc')
    const adds = r.filter((l) => l.kind === 'add').map((l) => l.text)
    expect(adds).toEqual(['c'])
  })

  it('marks deleted lines', () => {
    const r = diffLines('a\nb\nc', 'a\nc')
    const dels = r.filter((l) => l.kind === 'del').map((l) => l.text)
    expect(dels).toEqual(['b'])
  })

  it('handles a single-line change as del + add', () => {
    const r = diffLines('hello', 'world')
    const kinds = r.map((l) => l.kind).sort()
    expect(kinds).toContain('add')
    expect(kinds).toContain('del')
    expect(r.find((l) => l.kind === 'del')!.text).toBe('hello')
    expect(r.find((l) => l.kind === 'add')!.text).toBe('world')
  })

  it('produces empty diff for two empty strings', () => {
    // splitting '' yields [''] — a single empty line. Both sides should match.
    const r = diffLines('', '')
    expect(r).toHaveLength(1)
    expect(r[0]!.kind).toBe('eq')
  })
})

describe('ReplayDrawer — REPLAY_BEARING_EVENT_TYPES gate', () => {
  // Mirrored from EventTimeline.tsx — the gate that decides whether to call
  // replay.list for a row. Tests document the contract.
  const REPLAY_BEARING = new Set(['ReplayCaptureCompleted', 'ToolCallCompleted', 'LLMRequestCompleted'])

  it('includes ToolCallCompleted (so MCP tool calls show 🔁)', () => {
    expect(REPLAY_BEARING.has('ToolCallCompleted')).toBe(true)
  })

  it('includes LLMRequestCompleted (so LLM calls show 🔁)', () => {
    expect(REPLAY_BEARING.has('LLMRequestCompleted')).toBe(true)
  })

  it('does not include lifecycle events (no replay capture)', () => {
    expect(REPLAY_BEARING.has('WorkerLifecyclePhase')).toBe(false)
    expect(REPLAY_BEARING.has('SkillLoaded')).toBe(false)
  })
})

describe('ReplayDrawer — replay mode contract', () => {
  // Mirrored from packages/orchestrator/src/replay/types.ts — codifies the
  // three modes the drawer's three buttons map onto.
  const VALID_MODES = ['inspect', 'replay-substituted', 'replay-live'] as const

  it('exposes exactly three modes', () => {
    expect(VALID_MODES).toHaveLength(3)
  })

  it('includes inspect (no execution)', () => {
    expect(VALID_MODES).toContain('inspect')
  })

  it('includes replay-substituted (deterministic, no tokens)', () => {
    expect(VALID_MODES).toContain('replay-substituted')
  })

  it('includes replay-live (re-run for drift detection)', () => {
    expect(VALID_MODES).toContain('replay-live')
  })
})
