/**
 * verifiers/ci-evidence.ts — CI evidence merge helpers.
 *
 * Round 6 #6 — CI/CD Bridge
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Implements the evidence-kind precedence rules from architecture.md:
 *
 *   1. When CI evidence exists, prefer it over local test_run.
 *   2. If CI fails but local passes → result=fail, mismatch=true (fail-closed).
 *   3. If both agree on pass → primary=ci_run, mismatch=false.
 *   4. If no CI evidence → use local as-is.
 *
 * The merge logic is a pure function so it is easily testable without DB.
 */

import type { ACEvidenceResult, CIConclusion } from '../db/schema/ac-check-evidence.js'

// ---------------------------------------------------------------------------
// CI evidence shape (extended ACCheckEvidence)
// ---------------------------------------------------------------------------

export interface LocalCheckEvidence {
  ac_id: string
  ac_title: string
  result: ACEvidenceResult
  evidence_kind: 'test_run' | 'static_analysis' | 'llm_inspection' | 'manual_required'
  test_command?: string
  test_output?: string
  test_exit_code?: number
  llm_reasoning?: string
  files_inspected?: string[]
}

export interface CICheckEvidence {
  ac_id: string
  ac_title: string
  result: ACEvidenceResult
  evidence_kind: 'ci_run'
  ci_run_url?: string | null
  ci_check_name?: string | null
  ci_conclusion?: CIConclusion | null
  files_inspected?: string[]
}

export type MergeableCIEvidence = CICheckEvidence

/** Combined evidence shape (union of local + CI fields). */
export interface MergedEvidence {
  ac_id: string
  ac_title: string
  result: ACEvidenceResult
  evidence_kind: 'test_run' | 'static_analysis' | 'llm_inspection' | 'manual_required' | 'ci_run'
  test_command?: string
  test_output?: string
  test_exit_code?: number
  llm_reasoning?: string
  ci_run_url?: string | null
  ci_check_name?: string | null
  ci_conclusion?: CIConclusion | null
  files_inspected?: string[]
}

export interface MergeResult {
  /** The authoritative evidence to record as primary (written to ac_check_evidence). */
  primary: MergedEvidence
  /** Secondary (local) evidence, written as a second row for audit traceability. Null when no local evidence. */
  secondary: LocalCheckEvidence | null
  /**
   * True when CI fails but local passes — signals an operator-visible mismatch.
   * The verifier service logs a warning when mismatch=true.
   */
  mismatch: boolean
}

// ---------------------------------------------------------------------------
// CI conclusions that constitute failure
// ---------------------------------------------------------------------------

const FAILING_CONCLUSIONS = new Set<string>(['failure', 'cancelled', 'timed_out', 'action_required'])

function ciResultFromConclusion(conclusion: string | null | undefined): ACEvidenceResult {
  if (!conclusion) return 'ambiguous'
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return 'pass'
  if (FAILING_CONCLUSIONS.has(conclusion)) return 'fail'
  return 'ambiguous'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge CI evidence with optional local test evidence.
 *
 * Fail-closed rule: if CI is failing, the result is fail regardless of local result.
 *
 * @param local  Local test_run / llm_inspection evidence (may be null if CI ran first).
 * @param ci     CI run evidence from check_run webhook (null = no CI evidence yet).
 */
export function mergeCIEvidenceWithLocal(
  local: LocalCheckEvidence | null,
  ci: MergeableCIEvidence | null,
): MergeResult {
  // No CI evidence — use local as-is
  if (!ci) {
    if (!local) {
      throw new Error('mergeCIEvidenceWithLocal: both local and ci are null')
    }
    return {
      primary: { ...local },
      secondary: null,
      mismatch: false,
    }
  }

  // Determine CI result from conclusion
  const ciResult = ciResultFromConclusion(ci.ci_conclusion ?? null)

  // Determine mismatch: CI fails but local passed
  const mismatch =
    local !== null &&
    local.result === 'pass' &&
    ciResult === 'fail'

  const primary: MergedEvidence = {
    ac_id: ci.ac_id,
    ac_title: ci.ac_title,
    result: ciResult,
    evidence_kind: 'ci_run',
    ci_run_url: ci.ci_run_url ?? null,
    ci_check_name: ci.ci_check_name ?? null,
    ci_conclusion: ci.ci_conclusion ?? null,
    files_inspected: ci.files_inspected ?? [],
  }

  return {
    primary,
    secondary: local,
    mismatch,
  }
}

/**
 * Build a CICheckEvidence from a webhook check_run payload object.
 */
export function ciEvidenceFromCheckRun(params: {
  acId: string
  acTitle: string
  conclusion: string | null
  checkName: string
  htmlUrl: string
}): MergeableCIEvidence {
  return {
    ac_id: params.acId,
    ac_title: params.acTitle,
    result: ciResultFromConclusion(params.conclusion),
    evidence_kind: 'ci_run',
    ci_run_url: params.htmlUrl,
    ci_check_name: params.checkName,
    ci_conclusion: params.conclusion as CIConclusion | null,
  }
}
