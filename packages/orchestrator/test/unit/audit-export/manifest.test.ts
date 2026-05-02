/**
 * Unit tests for audit-export/manifest.ts
 *
 * Per task done criteria:
 *   - Every event_type in EVENT_TYPE_CONTROL_MAP has at least one SOC2 control
 *   - Manifest validates as valid JSON via PackageManifestSchema
 *   - Control mapping is valid JSON via Soc2ControlMappingSchema structure
 *   - ManifestBuilder.build() produces a valid PackageManifest
 *   - ManifestBuilder.serialize() produces parseable JSON
 *
 * No Postgres required.
 */

import { describe, it, expect } from 'vitest'
import {
  ManifestBuilder,
  PackageManifestSchema,
  ArtifactRecordSchema,
  EVENT_TYPE_CONTROL_MAP,
  DEFAULT_SOC2_CONTROL_MAPPING,
  type ArtifactRecord,
} from '../../../src/audit-export/manifest.js'

// ---------------------------------------------------------------------------
// SOC2 control mapping coverage
// ---------------------------------------------------------------------------

describe('EVENT_TYPE_CONTROL_MAP coverage', () => {
  it('every event_type maps to at least one SOC2 control', () => {
    const failures: string[] = []

    for (const [eventType, controls] of Object.entries(EVENT_TYPE_CONTROL_MAP)) {
      if (!controls || controls.length === 0) {
        failures.push(eventType)
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following event_types have no SOC2 control mapping: ${failures.join(', ')}`,
      )
    }
  })

  it('has at least 60 known event types (comprehensive coverage)', () => {
    const count = Object.keys(EVENT_TYPE_CONTROL_MAP).length
    expect(count).toBeGreaterThanOrEqual(60)
  })

  it('all mapped control IDs are valid Soc2ControlId values', () => {
    const validIds = new Set(['CC6.1', 'CC6.2', 'CC6.3', 'CC6.7', 'CC7.1', 'CC7.2', 'CC7.3', 'CC8.1', 'CC9.1', 'CC9.2'])
    const invalidMappings: string[] = []

    for (const [eventType, controls] of Object.entries(EVENT_TYPE_CONTROL_MAP)) {
      for (const control of controls) {
        if (!validIds.has(control)) {
          invalidMappings.push(`${eventType} → ${control}`)
        }
      }
    }

    if (invalidMappings.length > 0) {
      throw new Error(`Invalid SOC2 control IDs in mapping: ${invalidMappings.join(', ')}`)
    }
  })

  it('covers all 7 AuditExport lifecycle event types', () => {
    const exportEvents = [
      'AuditExportRequested',
      'AuditExportStarted',
      'AuditExportProgress',
      'AuditExportCompleted',
      'AuditExportFailed',
      'AuditExportDownloaded',
      'AuditExportCancelled',
    ]

    for (const eventType of exportEvents) {
      expect(EVENT_TYPE_CONTROL_MAP).toHaveProperty(eventType)
      expect(EVENT_TYPE_CONTROL_MAP[eventType]!.length).toBeGreaterThan(0)
    }
  })

  it('covers CBAC capability lifecycle events', () => {
    const cbacEvents = [
      'CapabilityGranted',
      'CapabilityRevoked',
      'CapabilityDenied',
      'CapabilityIssued',
      'KeyRotated',
      'KeyArchived',
    ]

    for (const eventType of cbacEvents) {
      expect(EVENT_TYPE_CONTROL_MAP).toHaveProperty(eventType)
    }
  })

  it('covers change-management events for CC8.1', () => {
    const cc81Events = [
      'AdrCreated',
      'PersonaVersionCreated',
      'RetroProposalCreated',
      'VerifierPassed',
      'VerifierFailed',
    ]

    for (const eventType of cc81Events) {
      expect(EVENT_TYPE_CONTROL_MAP).toHaveProperty(eventType)
      expect(EVENT_TYPE_CONTROL_MAP[eventType]!).toContain('CC8.1')
    }
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_SOC2_CONTROL_MAPPING validity
// ---------------------------------------------------------------------------

describe('DEFAULT_SOC2_CONTROL_MAPPING', () => {
  it('is valid JSON (serializable and parseable)', () => {
    const json = JSON.stringify(DEFAULT_SOC2_CONTROL_MAPPING)
    const parsed = JSON.parse(json) as typeof DEFAULT_SOC2_CONTROL_MAPPING
    expect(parsed.schema_version).toBe(1)
    expect(parsed.controls).toBeDefined()
  })

  it('schema_version is 1', () => {
    expect(DEFAULT_SOC2_CONTROL_MAPPING.schema_version).toBe(1)
  })

  it('contains controls for all required SOC2 control IDs', () => {
    const requiredControls = ['CC6.1', 'CC6.2', 'CC6.3', 'CC6.7', 'CC7.1', 'CC7.2', 'CC7.3', 'CC8.1', 'CC9.1', 'CC9.2']
    const presentIds = DEFAULT_SOC2_CONTROL_MAPPING.controls.map((c) => c.control_id)

    for (const required of requiredControls) {
      expect(presentIds).toContain(required)
    }
  })

  it('every control entry has non-empty evidence_paths and evidence_types', () => {
    for (const control of DEFAULT_SOC2_CONTROL_MAPPING.controls) {
      expect(control.evidence_paths.length).toBeGreaterThan(0)
      expect(control.evidence_types.length).toBeGreaterThan(0)
    }
  })

  it('every control entry has at least one query_hint', () => {
    for (const control of DEFAULT_SOC2_CONTROL_MAPPING.controls) {
      expect(control.query_hints.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// ManifestBuilder
// ---------------------------------------------------------------------------

const SAMPLE_ARTIFACTS: ArtifactRecord[] = [
  {
    path: 'events/events-2026-01.jsonl.zst',
    type: 'events_jsonl',
    range_start: '2026-01-01T00:00:00.000Z',
    range_end: '2026-02-01T00:00:00.000Z',
    record_count: 42,
    byte_length: 1024,
    sha256: 'a'.repeat(64),
  },
  {
    path: 'manifest.json',
    type: 'index',
    record_count: 1,
    byte_length: 512,
    sha256: 'b'.repeat(64),
  },
  {
    path: 'soc2_control_mapping.json',
    type: 'control_mapping',
    record_count: 1,
    byte_length: 2048,
    sha256: 'c'.repeat(64),
  },
  {
    path: 'README.md',
    type: 'readme',
    record_count: 1,
    byte_length: 800,
    sha256: 'd'.repeat(64),
  },
]

describe('ManifestBuilder', () => {
  const builder = new ManifestBuilder()

  it('build() produces an object that passes PackageManifestSchema validation', () => {
    const manifest = builder.build({
      exportId: '01234567-89ab-7000-1234-abcdef012345',
      installId: 'ffffffff-ffff-7000-aaaa-bbbbccccdddd',
      packageId: '12345678-9abc-7000-5678-abcdef012345',
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-03-31T23:59:59.999Z',
      scope: { kind: 'full_org' },
      cutoffEventId: '00000000-0000-7000-8888-ffffffffffff',
      requestedBy: { type: 'user', user_id: 'local-user', install_id: 'test' },
      capabilityId: 'cap-uuid-placeholder',
      justification: 'SOC2 annual audit export for Q1 2026',
      artifacts: SAMPLE_ARTIFACTS,
      totalEventCount: 42,
      signingKeyId: 'install-01234567',
      masterKeyPubB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      signedAt: '2026-05-01T10:00:00.000Z',
    })

    const parsed = PackageManifestSchema.safeParse(manifest)
    if (!parsed.success) {
      throw new Error(`Manifest failed schema validation: ${JSON.stringify(parsed.error.issues, null, 2)}`)
    }
  })

  it('serialize() produces valid JSON', () => {
    const manifest = builder.build({
      exportId: '01234567-89ab-7000-1234-abcdef012345',
      installId: 'ffffffff-ffff-7000-aaaa-bbbbccccdddd',
      packageId: '12345678-9abc-7000-5678-abcdef012345',
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-03-31T23:59:59.999Z',
      scope: { kind: 'full_org' },
      cutoffEventId: '00000000-0000-7000-8888-ffffffffffff',
      requestedBy: { type: 'user', user_id: 'local-user', install_id: 'test' },
      capabilityId: 'cap-uuid-placeholder',
      justification: 'Serialize test',
      artifacts: SAMPLE_ARTIFACTS,
      totalEventCount: 42,
      signingKeyId: 'install-01234567',
      masterKeyPubB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      signedAt: '2026-05-01T10:00:00.000Z',
    })

    const bytes = builder.serialize(manifest)

    expect(bytes).toBeInstanceOf(Buffer)
    expect(bytes.length).toBeGreaterThan(0)

    const parsed = JSON.parse(bytes.toString('utf-8')) as unknown
    expect(typeof parsed).toBe('object')
    expect((parsed as Record<string, unknown>)['schema_version']).toBe(1)
  })

  it('hash() produces a 64-character hex string', () => {
    const bytes = Buffer.from('{"schema_version":1}', 'utf-8')
    const hash = builder.hash(bytes)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('buildControlMapping() produces valid JSON with schema_version 1', () => {
    const buf = builder.buildControlMapping()
    const parsed = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
    expect(parsed['schema_version']).toBe(1)
    expect(Array.isArray(parsed['controls'])).toBe(true)
  })

  it('buildReadme() contains install_id and cutoff_event_id', () => {
    const installId = 'test-install-id-abc'
    const cutoffEventId = 'cutoff-event-xyz-123'
    const buf = builder.buildReadme({
      installId,
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-03-31T23:59:59.999Z',
      scopeSummary: 'full_org',
      cutoffEventId,
    })

    const text = buf.toString('utf-8')
    expect(text).toContain(installId)
    expect(text).toContain(cutoffEventId)
  })

  it('totals.total_bytes equals sum of artifact byte_lengths', () => {
    const manifest = builder.build({
      exportId: '01234567-89ab-7000-1234-abcdef012345',
      installId: 'ffffffff-ffff-7000-aaaa-bbbbccccdddd',
      packageId: '12345678-9abc-7000-5678-abcdef012345',
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-01-31T23:59:59.999Z',
      scope: { kind: 'full_org' },
      cutoffEventId: '00000000-0000-7000-8888-ffffffffffff',
      requestedBy: { type: 'user', user_id: 'u', install_id: 'i' },
      capabilityId: 'cap',
      justification: 'totals test',
      artifacts: SAMPLE_ARTIFACTS,
      totalEventCount: 42,
      signingKeyId: 'k',
      masterKeyPubB64: 'pub',
      signedAt: '2026-05-01T10:00:00.000Z',
    })

    const expectedTotalBytes = SAMPLE_ARTIFACTS.reduce((acc, a) => acc + a.byte_length, 0)
    expect(manifest.totals.total_bytes).toBe(expectedTotalBytes)
    expect(manifest.totals.artifact_count).toBe(SAMPLE_ARTIFACTS.length)
    expect(manifest.totals.event_count).toBe(42)
  })

  it('cutoff block has correct cutoff_rule literal', () => {
    const manifest = builder.build({
      exportId: '01234567-89ab-7000-1234-abcdef012345',
      installId: 'inst',
      packageId: 'pkg',
      rangeStart: '2026-01-01T00:00:00.000Z',
      rangeEnd: '2026-01-31T23:59:59.999Z',
      scope: { kind: 'full_org' },
      cutoffEventId: 'cutoff-id',
      requestedBy: { type: 'user', user_id: 'u', install_id: 'i' },
      capabilityId: 'cap',
      justification: 'cutoff test',
      artifacts: [],
      totalEventCount: 0,
      signingKeyId: 'k',
      masterKeyPubB64: 'pub',
      signedAt: '2026-05-01T10:00:00.000Z',
    })

    expect(manifest.cutoff.cutoff_rule).toBe('inclusive_through_AuditExportRequested')
    expect(manifest.cutoff.cutoff_event_id).toBe('cutoff-id')
  })
})

// ---------------------------------------------------------------------------
// ArtifactRecord schema
// ---------------------------------------------------------------------------

describe('ArtifactRecordSchema', () => {
  it('validates a valid artifact record', () => {
    const valid: ArtifactRecord = {
      path: 'events/events-2026-01.jsonl.zst',
      type: 'events_jsonl',
      record_count: 100,
      byte_length: 4096,
      sha256: 'a'.repeat(64),
    }

    expect(ArtifactRecordSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects sha256 that is not 64 hex characters', () => {
    const invalid = {
      path: 'test',
      type: 'events_jsonl',
      record_count: 0,
      byte_length: 0,
      sha256: 'not-hex',
    }

    expect(ArtifactRecordSchema.safeParse(invalid).success).toBe(false)
  })

  it('accepts all defined artifact types', () => {
    const types = [
      'events_jsonl', 'capability_grants_jsonl', 'capability_denials_jsonl',
      'ceremony_record', 'ceremony_transcript', 'adr_markdown',
      'retro_report', 'retro_proposal', 'retro_outcome',
      'uat_session', 'uat_defect', 'channel_posts_jsonl',
      'drift_event', 'persona_version', 'verifier_result',
      'key_history', 'index', 'readme', 'control_mapping',
    ]

    for (const type of types) {
      const result = ArtifactRecordSchema.safeParse({
        path: 'test.json',
        type,
        record_count: 0,
        byte_length: 0,
        sha256: 'f'.repeat(64),
      })
      expect(result.success, `type '${type}' should be valid`).toBe(true)
    }
  })
})
