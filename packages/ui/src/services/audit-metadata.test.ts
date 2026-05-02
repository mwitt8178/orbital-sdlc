/**
 * Tests for buildAuditMetadata helper. Asserts the produced envelope
 * matches the orchestrator's AuditMetadataInputSchema (Primitives §14):
 *   - actor.type === 'user'
 *   - justification is required
 *   - trace_id is a valid uuid
 *   - linked_artifacts defaults to []
 */

import { describe, it, expect } from 'vitest'
import { buildAuditMetadata } from './audit-metadata.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('buildAuditMetadata', () => {
  it('produces a complete envelope with default actor + linked_artifacts', () => {
    const md = buildAuditMetadata('Testing the helper')
    expect(md.actor).toEqual({
      type: 'user',
      user_id: 'local-user',
      install_id: 'web-ui',
    })
    expect(md.justification).toBe('Testing the helper')
    expect(md.trace_id).toMatch(UUID_RE)
    expect(md.linked_artifacts).toEqual([])
  })

  it('trims justification and rejects empty input', () => {
    expect(() => buildAuditMetadata('')).toThrow(/justification/)
    expect(() => buildAuditMetadata('   ')).toThrow(/justification/)
    expect(buildAuditMetadata('  do thing  ').justification).toBe('do thing')
  })

  it('passes through linked_artifacts when supplied', () => {
    const md = buildAuditMetadata('lock', {
      linked_artifacts: [{ type: 'vision_document', id: 'doc-1' }],
    })
    expect(md.linked_artifacts).toEqual([{ type: 'vision_document', id: 'doc-1' }])
  })

  it('honors user_id and install_id overrides', () => {
    const md = buildAuditMetadata('wizard step', {
      user_id: 'wizard-user',
      install_id: 'install-42',
    })
    expect(md.actor.user_id).toBe('wizard-user')
    expect(md.actor.install_id).toBe('install-42')
  })

  it('produces a unique trace_id per call', () => {
    const a = buildAuditMetadata('a').trace_id
    const b = buildAuditMetadata('b').trace_id
    expect(a).not.toBe(b)
  })
})
