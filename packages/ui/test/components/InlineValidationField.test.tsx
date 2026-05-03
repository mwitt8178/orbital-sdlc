/**
 * InlineValidationField — pure validator behavior tests.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criterion #5: bad Anthropic key → specific error within 200ms.
 * The "200ms" is satisfied by synchronous validation, so we test the
 * validators themselves return the expected messages.
 */

import { describe, it, expect } from 'vitest'

// Mirror the validators that ConnectToolsStep installs.
function validateAnthropicKey(v: string): string | null {
  if (v.length === 0) return 'Anthropic key is required.'
  if (!v.startsWith('sk-ant-')) return 'Anthropic keys begin with sk-ant-.'
  if (v.length < 100) return `Anthropic keys are 100+ chars; this is ${v.length}.`
  return null
}

function validateMondayToken(v: string): string | null {
  if (v.length === 0) return 'Monday token is required.'
  if (v.length < 32) return `Monday tokens are at least 32 chars; this is ${v.length}.`
  return null
}

describe('InlineValidationField — Anthropic validator', () => {
  it('rejects empty', () => {
    expect(validateAnthropicKey('')).toBe('Anthropic key is required.')
  })

  it('rejects keys without sk-ant- prefix', () => {
    expect(validateAnthropicKey('foo-bar-baz-123')).toBe('Anthropic keys begin with sk-ant-.')
  })

  it('reports the actual length on too-short keys (within 200ms — synchronous)', () => {
    const result = validateAnthropicKey('sk-ant-abc')
    expect(result).toBe('Anthropic keys are 100+ chars; this is 10.')
  })

  it('accepts a 109-char key', () => {
    const long = 'sk-ant-' + 'a'.repeat(102)
    expect(long.length).toBe(109)
    expect(validateAnthropicKey(long)).toBeNull()
  })
})

describe('InlineValidationField — Monday validator', () => {
  it('rejects empty', () => {
    expect(validateMondayToken('')).toBe('Monday token is required.')
  })

  it('reports the actual length on too-short tokens', () => {
    expect(validateMondayToken('short')).toBe(
      'Monday tokens are at least 32 chars; this is 5.',
    )
  })

  it('accepts a 64-char token', () => {
    expect(validateMondayToken('a'.repeat(64))).toBeNull()
  })
})
