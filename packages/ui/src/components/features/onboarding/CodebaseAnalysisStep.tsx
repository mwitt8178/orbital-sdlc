/**
 * CodebaseAnalysisStep — Flow B step 2: cost-transparent codebase analysis.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #8: cost transparency before any LLM-using step. The
 * pre-flight estimate shows expected $$ before the user can click Continue.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'

interface Props {
  sessionId: string
  projectId: string
  owner: string
  repo: string
  onComplete: (report: AnalysisReport) => void
}

export interface AnalysisReport {
  stack: string[]
  testRunner: string | null
  ciWorkflowCount: number
  commitConvention: string | null
  branchModel: string | null
  inferredMemoryEntries: Array<{
    kind: 'decision' | 'convention' | 'glossary' | 'learning' | 'anti_pattern'
    title: string
    body: string
    tags: string[]
    source?: { kind: 'adr' | 'readme' | 'pr' | 'file'; ref: string }
  }>
  llmCostUsd: number
  llmUsed: boolean
}

export function CodebaseAnalysisStep({ sessionId, projectId, owner, repo, onComplete }: Props) {
  const estimate = trpc.onboarding.estimateAnalyzeCodebase.useQuery(
    { owner, repo },
    { staleTime: 60_000, enabled: owner.length > 0 && repo.length > 0 },
  )
  const analyze = trpc.onboarding.analyzeCodebase.useMutation()

  const [useLLM, setUseLLM] = useState(true)
  const [report, setReport] = useState<AnalysisReport | null>(null)

  const startAnalysis = async () => {
    const res = await analyze.mutateAsync({ sessionId, projectId, owner, repo, useLLM })
    setReport(res)
    onComplete(res)
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Analyze the codebase</h1>
        <TimeEstimateBadge estSeconds={120} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Reads <span className="font-mono">{owner}/{repo}</span>. Static analysis is free; the
        LLM-assisted pass extracts conventions + ADRs and costs real money.
      </p>

      {!report && (
        <div className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
            <h2 className="mb-1 font-semibold text-slate-900">Pre-flight cost estimate</h2>
            {estimate.isLoading ? (
              <p className="text-slate-500">Loading…</p>
            ) : estimate.data ? (
              <>
                <p className="text-slate-700">
                  Plan: <span className="font-medium">{estimate.data.plan}</span>
                </p>
                <p className="mt-1 text-slate-700">
                  Estimated tokens:{' '}
                  <span className="font-medium">
                    {estimate.data.inputTokens.toLocaleString()} in /{' '}
                    {estimate.data.outputTokens.toLocaleString()} out
                  </span>
                </p>
                <p className="mt-1 text-slate-700">
                  Estimated cost:{' '}
                  <span className="font-bold">${estimate.data.costUsd.toFixed(2)}</span>
                </p>
              </>
            ) : (
              <p className="text-amber-700">Estimate unavailable; analysis will still run.</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={useLLM}
              onChange={(e) => setUseLLM(e.target.checked)}
              className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Run LLM-assisted analysis (recommended; ~${estimate.data?.costUsd.toFixed(2) ?? '0.85'})
          </label>

          <div>
            <Button
              variant="primary"
              size="lg"
              disabled={analyze.isPending}
              onClick={() => void startAnalysis()}
            >
              {analyze.isPending ? 'Analyzing…' : 'Analyze'}
            </Button>
          </div>
        </div>
      )}

      {report && (
        <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm" role="status" aria-live="polite">
          <p className="text-emerald-700">✓ Analysis complete</p>
          <ul className="space-y-1 text-slate-700">
            <li>Detected stack: {report.stack.join(', ') || '—'}</li>
            <li>Test runner: {report.testRunner ?? '—'}</li>
            <li>CI workflows: {report.ciWorkflowCount}</li>
            <li>Commit convention: {report.commitConvention ?? '—'}</li>
            <li>Branch model: {report.branchModel ?? '—'}</li>
            <li>Memory entries inferred: {report.inferredMemoryEntries.length}</li>
            {report.llmUsed && <li>LLM cost: ${report.llmCostUsd.toFixed(4)}</li>}
          </ul>
        </div>
      )}

      {analyze.isError && (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
          {analyze.error.message}
        </p>
      )}
    </div>
  )
}
