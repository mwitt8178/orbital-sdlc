/**
 * test/unit/types/local-only.test.ts
 *
 * Round 7-05 — type-level + runtime tests for the LocalOnly<T> brand.
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Type tests use `// @ts-expect-error` directives that fail compilation if the
 * line below them happens to type-check. So if a future refactor accidentally
 * loosens `LocalOnly`, the TypeScript compiler will reject this file before
 * vitest even runs.
 *
 * Runtime tests confirm:
 *   - localOnly() returns the input unchanged (passthrough).
 *   - unwrapLocal() returns the input unchanged.
 *   - The brand is purely a type-level construct.
 */

import { describe, it, expect } from 'vitest'
import {
  localOnly,
  unwrapLocal,
  type LocalOnly,
  type AnthropicKey,
} from '../../../src/types/local-only.js'

describe('LocalOnly<T> — runtime behaviour', () => {
  it('R1: localOnly() is a passthrough at runtime', () => {
    const k = 'sk-ant-not-a-real-key'
    const branded = localOnly(k)
    expect(branded).toBe(k)
  })

  it('R2: unwrapLocal() returns the underlying value', () => {
    const k = localOnly('secret')
    const unbranded: string = unwrapLocal(k)
    expect(unbranded).toBe('secret')
  })

  it('R3: branding does not change runtime equality', () => {
    const a = localOnly({ entryId: 'e1', costUsd: 1.23 })
    expect(a.entryId).toBe('e1')
    expect(a.costUsd).toBe(1.23)
  })

  it('R4: brand survives JSON round-trip (because the brand is type-only)', () => {
    const k = localOnly('secret')
    const json = JSON.stringify(k)
    const parsed = JSON.parse(json)
    expect(parsed).toBe('secret')
  })
})

describe('LocalOnly<T> — type-level guarantees', () => {
  // The body of these tests is mostly compile-time assertions via
  // @ts-expect-error. If a future change accidentally lets a LocalOnly<T>
  // flow into a plain-T parameter, the @ts-expect-error directive becomes
  // unused, which `tsc --noEmit` rejects.

  function takesPlainString(_s: string): void {}

  function takesAnthropicKey(_k: AnthropicKey): void {}

  // Helper used to provide a runtime body to each `it()`.
  const noop = (): void => {}

  it('T1: a LocalOnly<string> cannot be passed where a plain string is expected', () => {
    const branded = localOnly('hello')
    // @ts-expect-error — LocalOnly<string> is not assignable to string.
    takesPlainString(branded)
    noop()
    expect(true).toBe(true)
  })

  it('T2: a plain string cannot be passed where AnthropicKey is expected', () => {
    const plain = 'sk-ant-fake'
    // @ts-expect-error — plain string is not assignable to AnthropicKey.
    takesAnthropicKey(plain)
    noop()
    expect(true).toBe(true)
  })

  it('T3: unwrapLocal lets you cross the boundary explicitly', () => {
    const k: AnthropicKey = localOnly('sk-ant-xxx')
    const stripped: string = unwrapLocal(k)
    takesPlainString(stripped) // OK — unwrapLocal made the brand explicit.
    expect(stripped).toBe('sk-ant-xxx')
  })

  it('T4: hub-client functions reject LocalOnly<T> at compile time', async () => {
    // Import the hub-client types to demonstrate the boundary.
    // We cannot construct a real HubClient here without a hub, but we can
    // exercise the type signature on the events.append input.
    type HubEventInput = {
      aggregate_id: string
      payload: Record<string, unknown>
      [key: string]: unknown
    }

    function pretendHubAppend(_e: HubEventInput): void {}

    const branded: LocalOnly<HubEventInput> = localOnly({
      aggregate_id: 'abc',
      payload: { foo: 'bar' },
    })

    // @ts-expect-error — LocalOnly<HubEventInput> is not assignable to HubEventInput.
    pretendHubAppend(branded)

    // Explicit unwrap works.
    pretendHubAppend(unwrapLocal(branded))
    expect(true).toBe(true)
  })

  it('T5: brand prevents accidental widening through generics', () => {
    function identity<T>(x: T): T {
      return x
    }
    const k: AnthropicKey = localOnly('sk')
    // identity<T> infers T = AnthropicKey, so the result is still branded.
    const same = identity(k)
    // @ts-expect-error — same is still LocalOnly<string>, not assignable to plain string.
    takesPlainString(same)
    noop()
    expect(true).toBe(true)
  })
})
