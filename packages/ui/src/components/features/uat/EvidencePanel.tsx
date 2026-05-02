/**
 * EvidencePanel — expanded verifier-evidence card for a single AC.
 *
 * Round 5C: shown when the user clicks the verifier signal in ACChecklist.
 * Displays the framework-detected test command, captured output (collapsed
 * by default for size), the LLM reasoning when applicable, and the list of
 * files the verifier inspected.
 *
 * Round 6 #6: Added "CI Run" section for ci_run evidence kind.
 * Shows check_name, conclusion badge, duration, and link to GitHub Actions.
 * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
 *
 * Empty state ("verifier pending") is rendered by the parent ACChecklist; the
 * panel itself only renders when evidence is non-null.
 */

import { useState } from 'react'

export type EvidenceKind =
  | 'test_run'
  | 'static_analysis'
  | 'llm_inspection'
  | 'manual_required'
  | 'ci_run'

export interface EvidencePanelEvidence {
  evidence_id: string
  verification_id: string
  ac_id: string
  result: 'pass' | 'fail' | 'ambiguous'
  evidence_kind: EvidenceKind
  test_command: string | null
  test_output: string | null
  test_exit_code: number | null
  llm_reasoning: string | null
  files_inspected: string[]
  created_at: string
  /** CI fields — only set when evidence_kind='ci_run' */
  ci_run_url?: string | null
  ci_check_name?: string | null
  ci_conclusion?: string | null
}

interface EvidencePanelProps {
  evidence: EvidencePanelEvidence
}

const RESULT_LABEL: Record<EvidencePanelEvidence['result'], string> = {
  pass: 'Pass',
  fail: 'Fail',
  ambiguous: 'Ambiguous',
}

export const KIND_LABEL: Record<EvidenceKind, string> = {
  test_run: 'Test run',
  static_analysis: 'Static analysis',
  llm_inspection: 'LLM inspection',
  manual_required: 'Manual verification required',
  ci_run: 'CI run',
}

// ---------------------------------------------------------------------------
// CI conclusion badge
// ---------------------------------------------------------------------------

const CI_CONCLUSION_CLASSES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  failure: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-600',
  skipped: 'bg-slate-100 text-slate-500',
  timed_out: 'bg-amber-100 text-amber-700',
  neutral: 'bg-slate-100 text-slate-600',
  action_required: 'bg-amber-100 text-amber-700',
}

function CIConclusionBadge({ conclusion }: { conclusion: string }) {
  const classes = CI_CONCLUSION_CLASSES[conclusion] ?? 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${classes}`}>
      {conclusion}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CI Run section
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

function CIRunSection({ evidence }: { evidence: EvidencePanelEvidence }) {
  if (evidence.evidence_kind !== 'ci_run') return null

  return (
    <div
      className="mt-3 border-t border-slate-200 pt-3"
      aria-label="CI run details"
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        CI Run
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
        {evidence.ci_check_name && (
          <>
            <dt className="font-semibold text-slate-600">Check name</dt>
            <dd className="text-slate-900">{evidence.ci_check_name}</dd>
          </>
        )}

        {evidence.ci_conclusion && (
          <>
            <dt className="font-semibold text-slate-600">Conclusion</dt>
            <dd>
              <CIConclusionBadge conclusion={evidence.ci_conclusion} />
            </dd>
          </>
        )}

        {evidence.ci_run_url && (
          <>
            <dt className="font-semibold text-slate-600">GitHub Actions</dt>
            <dd>
              <a
                href={evidence.ci_run_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-brand-600 underline underline-offset-2 hover:text-brand-800"
                aria-label="Open CI run in GitHub Actions"
              >
                View run
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EvidencePanel({ evidence }: EvidencePanelProps) {
  const [outputOpen, setOutputOpen] = useState(false)

  return (
    <div
      className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs"
      role="region"
      aria-label={`Verifier evidence for AC ${evidence.ac_id}`}
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
        <dt className="font-semibold text-slate-600">Result</dt>
        <dd className="text-slate-900">{RESULT_LABEL[evidence.result]}</dd>

        <dt className="font-semibold text-slate-600">Evidence kind</dt>
        <dd className="text-slate-900">{KIND_LABEL[evidence.evidence_kind]}</dd>

        {evidence.test_command !== null && evidence.test_command !== '' && (
          <>
            <dt className="font-semibold text-slate-600">Test command</dt>
            <dd>
              <code className="block break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-800">
                {evidence.test_command}
              </code>
            </dd>
          </>
        )}

        {evidence.test_exit_code !== null && (
          <>
            <dt className="font-semibold text-slate-600">Exit code</dt>
            <dd className="text-slate-900">
              <span
                className={
                  evidence.test_exit_code === 0 ? 'text-emerald-700' : 'text-rose-700'
                }
              >
                {evidence.test_exit_code}
              </span>
            </dd>
          </>
        )}

        {evidence.llm_reasoning !== null && evidence.llm_reasoning !== '' && (
          <>
            <dt className="font-semibold text-slate-600">LLM reasoning</dt>
            <dd className="whitespace-pre-wrap text-slate-800">{evidence.llm_reasoning}</dd>
          </>
        )}

        {evidence.files_inspected.length > 0 && (
          <>
            <dt className="font-semibold text-slate-600">Files inspected</dt>
            <dd>
              <ul className="space-y-0.5">
                {evidence.files_inspected.map((f) => (
                  <li key={f} className="font-mono text-[11px] text-slate-700">
                    {f}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}

        <dt className="font-semibold text-slate-600">Recorded</dt>
        <dd className="text-slate-700">{new Date(evidence.created_at).toLocaleString()}</dd>
      </dl>

      {/* CI Run section — Round 6 #6 */}
      <CIRunSection evidence={evidence} />

      {evidence.test_output !== null && evidence.test_output !== '' && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-900"
            onClick={() => setOutputOpen((v) => !v)}
            aria-expanded={outputOpen}
            aria-controls={`evidence-output-${evidence.evidence_id}`}
          >
            <span>{outputOpen ? '▾' : '▸'}</span>
            Test output ({evidence.test_output.length} chars)
          </button>
          {outputOpen && (
            <pre
              id={`evidence-output-${evidence.evidence_id}`}
              className="mt-2 max-h-72 overflow-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-800"
            >
              {evidence.test_output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
