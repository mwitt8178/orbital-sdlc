/**
 * CI evidence precedence integration test.
 *
 * Round 6 #6 — CI/CD Bridge
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Tests the fail-closed rule:
 *   - local test_run=pass + CI ci_run=fail → AC result must be fail
 *   - local test_run=pass + CI ci_run=success → both recorded; primary=ci_run
 *   - no CI evidence → local test_run is used
 *
 * Uses real EvidenceStore + in-memory EventStore stub (no Fastify, no network).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { acCheckEvidence } from '../../../src/db/schema/ac-check-evidence.js'
import { createEvidenceStore } from '../../../src/verifiers/evidence.js'
import { mergeCIEvidenceWithLocal } from '../../../src/verifiers/ci-evidence.js'

let eventStore: ReturnType<typeof createEventStore>
let evidenceStore: ReturnType<typeof createEvidenceStore>
let testVerificationId: string

beforeAll(async () => {
  eventStore = createEventStore(db)
  evidenceStore = createEvidenceStore(db, eventStore)
})

afterAll(async () => {
  await closeDb()
})

beforeEach(async () => {
  testVerificationId = uuidv7()
  // Clean slate for each test
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CI evidence precedence — mergeCIEvidenceWithLocal', () => {
  it('returns ci_run evidence with result=fail when CI fails (overrides local pass)', () => {
    const localEvidence = {
      ac_id: uuidv7(),
      ac_title: 'Component renders correctly',
      result: 'pass' as const,
      evidence_kind: 'test_run' as const,
      test_command: 'npx vitest run',
      test_exit_code: 0,
      files_inspected: [],
    }

    const ciEvidence = {
      ac_id: localEvidence.ac_id,
      ac_title: localEvidence.ac_title,
      result: 'fail' as const,
      evidence_kind: 'ci_run' as const,
      ci_run_url: 'https://github.com/owner/repo/runs/12345',
      ci_check_name: 'CI / vitest',
      ci_conclusion: 'failure' as const,
      files_inspected: [],
    }

    const merged = mergeCIEvidenceWithLocal(localEvidence, ciEvidence)
    // Fail-closed: CI fail overrides local pass
    expect(merged.primary.result).toBe('fail')
    expect(merged.primary.evidence_kind).toBe('ci_run')
    expect(merged.mismatch).toBe(true)
    expect(merged.primary.ci_conclusion).toBe('failure')
  })

  it('returns ci_run evidence with result=pass when both agree on pass', () => {
    const localEvidence = {
      ac_id: uuidv7(),
      ac_title: 'API returns 200',
      result: 'pass' as const,
      evidence_kind: 'test_run' as const,
      test_exit_code: 0,
      files_inspected: [],
    }

    const ciEvidence = {
      ac_id: localEvidence.ac_id,
      ac_title: localEvidence.ac_title,
      result: 'pass' as const,
      evidence_kind: 'ci_run' as const,
      ci_run_url: 'https://github.com/owner/repo/runs/22222',
      ci_check_name: 'CI / vitest',
      ci_conclusion: 'success' as const,
      files_inspected: [],
    }

    const merged = mergeCIEvidenceWithLocal(localEvidence, ciEvidence)
    expect(merged.primary.result).toBe('pass')
    expect(merged.primary.evidence_kind).toBe('ci_run')
    expect(merged.mismatch).toBe(false)
  })

  it('returns local evidence when no CI evidence is provided', () => {
    const localEvidence = {
      ac_id: uuidv7(),
      ac_title: 'Login works',
      result: 'pass' as const,
      evidence_kind: 'test_run' as const,
      test_exit_code: 0,
      files_inspected: [],
    }

    const merged = mergeCIEvidenceWithLocal(localEvidence, null)
    expect(merged.primary.evidence_kind).toBe('test_run')
    expect(merged.mismatch).toBe(false)
  })

  it('returns ci_run fail when local fails too (no mismatch)', () => {
    const localEvidence = {
      ac_id: uuidv7(),
      ac_title: 'Button click works',
      result: 'fail' as const,
      evidence_kind: 'test_run' as const,
      test_exit_code: 1,
      files_inspected: [],
    }

    const ciEvidence = {
      ac_id: localEvidence.ac_id,
      ac_title: localEvidence.ac_title,
      result: 'fail' as const,
      evidence_kind: 'ci_run' as const,
      ci_run_url: 'https://github.com/owner/repo/runs/33333',
      ci_check_name: 'CI / vitest',
      ci_conclusion: 'failure' as const,
      files_inspected: [],
    }

    const merged = mergeCIEvidenceWithLocal(localEvidence, ciEvidence)
    expect(merged.primary.result).toBe('fail')
    expect(merged.mismatch).toBe(false)
  })
})

describe('CI evidence precedence — recordEvidence with ci_run', () => {
  it('persists ci_run evidence row with ci fields populated', async () => {
    const acId = uuidv7()
    const verificationId = uuidv7()

    const evidenceId = await evidenceStore.recordEvidence({
      verificationId,
      evidence: {
        ac_id: acId,
        ac_title: 'Feature works correctly',
        result: 'pass',
        evidence_kind: 'ci_run',
        ci_run_url: 'https://github.com/owner/repo/runs/55555',
        ci_check_name: 'CI / vitest',
        ci_conclusion: 'success',
        files_inspected: [],
      },
      traceId: uuidv7(),
      actor: { type: 'persona', persona_id: 'verifier', session_id: uuidv7() },
    })

    expect(evidenceId).toBeTruthy()

    // Verify the row was persisted with CI fields
    const rows = await db
      .select()
      .from(acCheckEvidence)
      .where(eq(acCheckEvidence.evidenceId, evidenceId))
      .limit(1)

    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.evidenceKind).toBe('ci_run')
    expect(row.ciRunUrl).toBe('https://github.com/owner/repo/runs/55555')
    expect(row.ciCheckName).toBe('CI / vitest')
    expect(row.ciConclusion).toBe('success')
    expect(row.result).toBe('pass')
  })
})
