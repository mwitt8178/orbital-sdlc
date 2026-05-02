/**
 * HubTabLocalOnlyPanel — unit tests for the LocalOnlyDataPanel inside HubTab.
 *
 * Round 7-05 — Local-Only Concerns Isolation
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Tests the pure helper that drives panel rendering. Following the pattern in
 * HubTab.test.tsx and HubStatusIndicator.test.tsx — the component itself is
 * a thin shell over the helper; testing the helper covers the value
 * formatting and empty/loading states without booting React Query.
 */

import { describe, it, expect } from 'vitest'
import { deriveLocalOnlyRows } from '../../src/components/features/settings/LocalOnlyDataPanel.js'

describe('LocalOnlyDataPanel — deriveLocalOnlyRows', () => {
  it('LO1: renders Loading... when all data is null', () => {
    const rows = deriveLocalOnlyRows(null, null, null)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.value).toBe('Loading...')
    }
  })

  it('LO2: anthropicKey row shows Configured when true', () => {
    const rows = deriveLocalOnlyRows(true, 0, 0)
    const apiKeyRow = rows.find((r) => r.label === 'Anthropic API key')
    expect(apiKeyRow?.value).toBe('Configured')
  })

  it('LO3: anthropicKey row shows Not configured when false', () => {
    const rows = deriveLocalOnlyRows(false, 0, 0)
    const apiKeyRow = rows.find((r) => r.label === 'Anthropic API key')
    expect(apiKeyRow?.value).toBe('Not configured')
  })

  it('LO4: replay row pluralises correctly (singular)', () => {
    const rows = deriveLocalOnlyRows(true, 1, 0)
    const replayRow = rows.find((r) => r.label === 'Replay blobs')
    expect(replayRow?.value).toBe('1 capture on disk')
  })

  it('LO5: replay row pluralises correctly (plural)', () => {
    const rows = deriveLocalOnlyRows(true, 12, 0)
    const replayRow = rows.find((r) => r.label === 'Replay blobs')
    expect(replayRow?.value).toBe('12 captures on disk')
  })

  it('LO6: replay row shows 0 captures cleanly', () => {
    const rows = deriveLocalOnlyRows(true, 0, 0)
    const replayRow = rows.find((r) => r.label === 'Replay blobs')
    expect(replayRow?.value).toBe('0 captures on disk')
  })

  it('LO7: cost ledger row pluralises correctly (singular)', () => {
    const rows = deriveLocalOnlyRows(true, 0, 1)
    const costRow = rows.find((r) => r.label === 'Cost ledger entries')
    expect(costRow?.value).toBe('1 entry for the active project')
  })

  it('LO8: cost ledger row pluralises correctly (plural)', () => {
    const rows = deriveLocalOnlyRows(true, 0, 7)
    const costRow = rows.find((r) => r.label === 'Cost ledger entries')
    expect(costRow?.value).toBe('7 entries for the active project')
  })

  it('LO9: every row carries a non-empty help text mentioning the locality contract', () => {
    const rows = deriveLocalOnlyRows(true, 5, 5)
    for (const r of rows) {
      expect(r.helpText.length).toBeGreaterThan(0)
    }
    // The Anthropic row specifically must mention "hub" for trust.
    const apiKeyRow = rows.find((r) => r.label === 'Anthropic API key')
    expect(apiKeyRow?.helpText.toLowerCase()).toContain('hub')
  })

  it('LO10: replay row help text mentions ~/.orbital/replays/', () => {
    const rows = deriveLocalOnlyRows(true, 5, 5)
    const replayRow = rows.find((r) => r.label === 'Replay blobs')
    expect(replayRow?.helpText).toContain('~/.orbital/replays/')
  })

  it('LO11: cost row help text mentions opt-in for sharing', () => {
    const rows = deriveLocalOnlyRows(true, 5, 5)
    const costRow = rows.find((r) => r.label === 'Cost ledger entries')
    expect(costRow?.helpText.toLowerCase()).toContain('opt-in')
  })
})
