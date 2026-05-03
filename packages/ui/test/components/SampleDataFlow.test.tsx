/**
 * SampleDataFlow — pure logic tests.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { describe, it, expect } from 'vitest'

interface SandboxStatus {
  kind: 'idle' | 'loading' | 'loaded' | 'error'
  bannerText?: string
  conversionCta?: string
}

function bannerForStatus(s: SandboxStatus): string | null {
  if (s.kind !== 'loaded') return null
  return s.bannerText ?? null
}

function conversionCtaForStatus(s: SandboxStatus): string | null {
  if (s.kind !== 'loaded') return null
  return s.conversionCta ?? null
}

describe('SampleDataFlow — banner + CTA', () => {
  it('hides banner while loading', () => {
    expect(bannerForStatus({ kind: 'loading' })).toBeNull()
  })

  it('hides banner on error', () => {
    expect(bannerForStatus({ kind: 'error' })).toBeNull()
  })

  it('exposes banner text once loaded', () => {
    const status: SandboxStatus = {
      kind: 'loaded',
      bannerText: "You're in sample mode. Switch to a real project anytime.",
      conversionCta: 'Ready to set up your real project?',
    }
    expect(bannerForStatus(status)).toContain('sample mode')
    expect(conversionCtaForStatus(status)).toContain('Ready to set up')
  })
})
