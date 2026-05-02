/**
 * Unit tests for anthropic-validate.ts.
 *
 * We don't make real API calls in unit tests — instead we exercise the
 * error-formatting branches by injecting a stub validator. The integration
 * test would hit the real API.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  getAnthropicValidator,
  setAnthropicValidator,
} from '../../../src/onboarding/anthropic-validate.js'

afterEach(() => {
  setAnthropicValidator(null)
})

describe('anthropic-validate', () => {
  it('rejects an empty key without making a network call', async () => {
    const v = getAnthropicValidator()
    const r = await v.validate('')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('empty')
  })

  it('rejects whitespace-only keys', async () => {
    const v = getAnthropicValidator()
    const r = await v.validate('   ')
    expect(r.ok).toBe(false)
  })

  it('honors a stub validator override', async () => {
    setAnthropicValidator({
      validate: async () => ({ ok: true, balanceCents: null }),
    })
    const v = getAnthropicValidator()
    const r = await v.validate('sk-ant-stub')
    expect(r.ok).toBe(true)
    expect(r.balanceCents).toBeNull()
  })

  it('passes through a stubbed error message', async () => {
    setAnthropicValidator({
      validate: async () => ({ ok: false, message: 'invalid' }),
    })
    const v = getAnthropicValidator()
    const r = await v.validate('sk-ant-bad')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('invalid')
  })
})
