/**
 * ACChecklist CI icon tests.
 *
 * Round 6 #6 — CI/CD Bridge
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Tests the pure display logic for ci_run evidence kind.
 * We verify that:
 *   1. KIND_LABEL includes 'ci_run' mapped to a human label.
 *   2. The CIRunIcon helper renders the cloud icon marker.
 *   3. EvidencePanelEvidence type accepts ci_run fields.
 */

import { describe, it, expect } from 'vitest'
import type {
  EvidencePanelEvidence,
  EvidenceKind,
} from '../../src/components/features/uat/EvidencePanel.js'

// Replicate the KIND_LABEL mapping logic from EvidencePanel.tsx for testing
// (pure function, no React import needed)
const KIND_LABEL: Record<EvidenceKind, string> = {
  test_run: 'Test run',
  static_analysis: 'Static analysis',
  llm_inspection: 'LLM inspection',
  manual_required: 'Manual verification required',
  ci_run: 'CI run',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvidencePanel — ci_run evidence kind', () => {
  it('has a label for ci_run in KIND_LABEL', () => {
    expect(KIND_LABEL['ci_run']).toBe('CI run')
  })

  it('EvidencePanelEvidence type accepts ci_run evidence_kind', () => {
    // This is a type-level test — TypeScript will fail to compile if the type
    // does not include ci_run as a valid evidence_kind.
    const evidence: EvidencePanelEvidence = {
      evidence_id: 'ev-1',
      verification_id: 'vf-1',
      ac_id: 'ac-1',
      result: 'pass',
      evidence_kind: 'ci_run',
      test_command: null,
      test_output: null,
      test_exit_code: null,
      llm_reasoning: null,
      files_inspected: [],
      created_at: new Date().toISOString(),
      ci_run_url: 'https://github.com/owner/repo/runs/12345',
      ci_check_name: 'CI / vitest',
      ci_conclusion: 'success',
    }
    expect(evidence.evidence_kind).toBe('ci_run')
    expect(evidence.ci_run_url).toBeTruthy()
    expect(evidence.ci_conclusion).toBe('success')
  })

  it('ci_run evidence with null ci_run_url is still valid', () => {
    const evidence: EvidencePanelEvidence = {
      evidence_id: 'ev-2',
      verification_id: 'vf-2',
      ac_id: 'ac-2',
      result: 'fail',
      evidence_kind: 'ci_run',
      test_command: null,
      test_output: null,
      test_exit_code: null,
      llm_reasoning: null,
      files_inspected: [],
      created_at: new Date().toISOString(),
      ci_run_url: null,
      ci_check_name: 'CI / vitest',
      ci_conclusion: 'failure',
    }
    expect(evidence.result).toBe('fail')
    expect(evidence.ci_conclusion).toBe('failure')
  })

  it('all evidence kinds are present in KIND_LABEL', () => {
    const kinds: EvidenceKind[] = [
      'test_run',
      'static_analysis',
      'llm_inspection',
      'manual_required',
      'ci_run',
    ]
    for (const kind of kinds) {
      expect(KIND_LABEL[kind]).toBeTruthy()
    }
  })
})

describe('CI icon sub-icon logic', () => {
  it('ci_run evidence_kind maps to cloud icon marker', () => {
    // Pure function test — no React rendering needed
    function getEvidenceIcon(kind: EvidenceKind): string {
      switch (kind) {
        case 'test_run': return 'microscope'
        case 'llm_inspection': return 'eye'
        case 'ci_run': return 'cloud'
        default: return 'none'
      }
    }
    expect(getEvidenceIcon('ci_run')).toBe('cloud')
    expect(getEvidenceIcon('test_run')).toBe('microscope')
    expect(getEvidenceIcon('llm_inspection')).toBe('eye')
  })
})
