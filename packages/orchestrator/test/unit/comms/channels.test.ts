/**
 * Unit tests for ChannelsService helpers (no DB required).
 *
 * Per TRD-05 §7.2 (Typed Post Catalog), §7.3 (cross-reference parser),
 * §10.1 (channel name canonicalization).
 */

import { describe, it, expect } from 'vitest'
import {
  POST_TYPE_SCHEMAS,
  validatePostPayload,
  parseCrossReferences,
  StatusUpdatePayloadV1,
  CeremonyStatementPayloadV1,
  CrossPostPayloadV1,
  AlertPayloadV1,
  CHANNEL_POST_TYPE,
} from '../../../src/comms/types.js'
import { canonicalChannelName } from '../../../src/comms/channels.js'

describe('canonicalChannelName', () => {
  it('produces #orb-<ticket> for ticket_durable', () => {
    expect(canonicalChannelName('ticket_durable', 'ORB-237')).toBe('#orb-orb-237')
  })

  it('produces #scratch-orb-<ticket> for ticket_scratch', () => {
    expect(canonicalChannelName('ticket_scratch', 'ORB-237')).toBe('#scratch-orb-orb-237')
  })

  it('produces #sprint-<n> for sprint kind', () => {
    expect(canonicalChannelName('sprint', '14')).toBe('#sprint-14')
  })

  it('preserves a leading # for topic kind', () => {
    expect(canonicalChannelName('topic', '#security-alerts')).toBe('#security-alerts')
  })

  it('uses ceremony id without # for ceremony kind', () => {
    expect(canonicalChannelName('ceremony', '01900000-0000-7000-8000-000000000001')).toBe(
      '01900000-0000-7000-8000-000000000001',
    )
  })
})

describe('Typed Post Catalog (TRD-05 §7.2)', () => {
  it('registers a schema for every post type', () => {
    for (const t of CHANNEL_POST_TYPE) {
      expect(POST_TYPE_SCHEMAS[t]).toBeDefined()
    }
  })

  it('accepts a valid status_update payload', () => {
    const out = validatePostPayload('status_update', {
      body: 'Working on it',
      progress_pct: 50,
    })
    expect(out['body']).toBe('Working on it')
    expect(out['progress_pct']).toBe(50)
  })

  it('rejects status_update with empty body', () => {
    expect(() => validatePostPayload('status_update', { body: '' })).toThrow()
  })

  it('rejects status_update with progress_pct out of range', () => {
    expect(() => validatePostPayload('status_update', { body: 'x', progress_pct: 150 })).toThrow()
  })

  it('accepts a valid alert with critical severity', () => {
    const out = validatePostPayload('alert', {
      severity: 'critical',
      title: 'Production down',
      body: 'Investigate now',
      source: 'security_officer',
    })
    expect(out['severity']).toBe('critical')
  })

  it('rejects an alert with invalid source', () => {
    expect(() =>
      validatePostPayload('alert', {
        severity: 'high',
        title: 't',
        body: 'b',
        source: 'unknown_source',
      }),
    ).toThrow()
  })

  it('accepts a ceremony_statement under the 6000 char limit', () => {
    const out = validatePostPayload('ceremony_statement', { body: 'short' })
    expect(out['body']).toBe('short')
  })

  it('rejects a ceremony_statement over 6000 chars', () => {
    const long = 'x'.repeat(6001)
    expect(() => validatePostPayload('ceremony_statement', { body: long })).toThrow()
  })

  it('accepts a cross_post with all required fields', () => {
    const out = validatePostPayload('cross_post', {
      origin_channel_id: '01900000-0000-7000-8000-000000000001',
      origin_post_id: '01900000-0000-7000-8000-000000000002',
      origin_author_role: 'architect',
      badge_label: 'ADR LINK',
      summary: 'A short summary',
    })
    expect(out['badge_label']).toBe('ADR LINK')
  })

  it('throws for an unknown post_type', () => {
    expect(() =>
      validatePostPayload('does_not_exist' as unknown as typeof CHANNEL_POST_TYPE[number], {}),
    ).toThrow()
  })
})

describe('parseCrossReferences (TRD-05 §7.3)', () => {
  it('parses a ticket reference (~ORB-237)', () => {
    const refs = parseCrossReferences('Hello ~ORB-237 world')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ refType: 'ticket', refId: 'ORB-237' })
  })

  it('parses a channel reference (#sprint-14)', () => {
    const refs = parseCrossReferences('See #sprint-14 for context')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ refType: 'channel', refId: '#sprint-14' })
  })

  it('parses an ADR reference (ADR-014)', () => {
    const refs = parseCrossReferences('Per ADR-014 we now do X')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ refType: 'adr', refId: 'ADR-014' })
  })

  it('parses multiple references in order', () => {
    const refs = parseCrossReferences('See ~ORB-1 and ADR-3 in #sprint-9')
    expect(refs).toHaveLength(3)
    expect(refs.map((r) => r.refType)).toEqual(['ticket', 'adr', 'channel'])
  })

  it('returns empty for plain text', () => {
    expect(parseCrossReferences('hello world')).toEqual([])
  })

  it('records correct offsets', () => {
    const body = 'a ~ORB-1 b'
    const refs = parseCrossReferences(body)
    const [r] = refs
    expect(r).toBeDefined()
    if (!r) return
    expect(body.slice(r.startOffset, r.endOffset)).toBe('~ORB-1')
  })
})
