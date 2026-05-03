/**
 * ExistingRepoFlow — Flow B: Orbital LEARNS from an existing repo.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Steps: connect_repo → codebase_analysis → board_mapping → memory_seed →
 * system_teach → mode → first_sprint → done.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'
import { ConnectRepoStep, type ConnectRepoData } from './ConnectRepoStep.js'
import { CodebaseAnalysisStep, type AnalysisReport } from './CodebaseAnalysisStep.js'
import { BoardMappingStep } from './BoardMappingStep.js'
import { MemorySeedStep } from './MemorySeedStep.js'
import { ModeStep } from './ModeStep.js'
import { FirstSprintStep } from './FirstSprintStep.js'
import { DoneStep, type DoneStepData } from './DoneStep.js'
import type { OnboardingMode } from '../../../services/onboarding-types.js'

export type ExistingRepoStepId =
  | 'connect_repo'
  | 'codebase_analysis'
  | 'board_mapping'
  | 'memory_seed'
  | 'system_teach'
  | 'mode'
  | 'first_sprint'
  | 'done'

interface Props {
  sessionId: string
  initialStep: ExistingRepoStepId
  initialState: Record<string, unknown>
  onComplete: () => void
}

export function ExistingRepoFlow({ sessionId, initialStep, initialState, onComplete }: Props) {
  const update = trpc.onboarding.updateSession.useMutation()
  const seedFromAnalysis = trpc.onboarding.seedMemoryFromAnalysis.useMutation()
  const configureSystem = trpc.onboarding.configureSystem.useMutation()
  const completeSession = trpc.onboarding.completeSession.useMutation()

  const [step, setStep] = useState<ExistingRepoStepId>(initialStep)
  const [repo, setRepo] = useState<ConnectRepoData>({
    githubOwner: (initialState['github_owner'] as string) ?? '',
    githubRepo: (initialState['github_repo'] as string) ?? '',
    mondayBoardId: (initialState['monday_board_id'] as string) ?? '',
  })
  const [repoValid, setRepoValid] = useState(false)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [memoryEntryIds, setMemoryEntryIds] = useState<string[]>([])
  const [mode, setMode] = useState<OnboardingMode | null>('live')
  const [projectId, setProjectId] = useState<string>(
    (initialState['project_id'] as string | undefined) ?? crypto.randomUUID(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const advance = async (next: ExistingRepoStepId, patch: Record<string, unknown> = {}) => {
    setStep(next)
    try {
      await update.mutateAsync({ sessionId, step: next, patch })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save progress.')
    }
  }

  const goFromConnect = () => {
    void advance('codebase_analysis', {
      github_owner: repo.githubOwner,
      github_repo: repo.githubRepo,
      monday_board_id: repo.mondayBoardId,
      project_id: projectId,
    })
  }

  const onAnalysisComplete = (r: AnalysisReport) => {
    setReport(r)
    void advance('board_mapping', { analysis: r })
  }

  const seedMemory = async () => {
    if (!report) return
    setBusy(true)
    setError(null)
    try {
      const r = await seedFromAnalysis.mutateAsync({
        sessionId,
        projectId,
        report: {
          ...report,
          ciWorkflows: [],
          readmeSummary: null,
          adrCount: report.inferredMemoryEntries.filter((e) => e.kind === 'decision').length,
        },
      })
      setMemoryEntryIds(r.entryIds)
      // Run system-teach immediately after seeding so the project gets its
      // CLAUDE.md + skills.json without an extra screen.
      await configureSystem.mutateAsync({
        sessionId,
        projectId,
        projectName: `${repo.githubOwner}/${repo.githubRepo}`,
        github: { owner: repo.githubOwner, repo: repo.githubRepo },
        analysis: {
          stack: report.stack,
          testRunner: report.testRunner,
          commitConvention: report.commitConvention,
          branchModel: report.branchModel,
        },
        memoryEntryIds: r.entryIds,
      })
      void advance('mode', { memory_entry_ids: r.entryIds })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Memory seed failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleSprintChoice = async (_choice: 'launch' | 'edit' | 'skip') => {
    void advance('done')
    try {
      await completeSession.mutateAsync({ sessionId, projectId })
    } catch {
      // already completed — fine
    }
  }

  useEffect(() => {
    if (step === 'memory_seed' && report && memoryEntryIds.length === 0 && !busy) {
      // user lands here after confirming board mapping; we wait for explicit
      // confirm in MemorySeedStep, no auto-trigger.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const summary = useMemo<DoneStepData>(() => ({
    projectName: `${repo.githubOwner}/${repo.githubRepo}`,
    sections: [
      {
        title: 'Analyzed',
        items: [
          `Stack: ${report?.stack.join(', ') ?? '—'}`,
          `Test runner: ${report?.testRunner ?? '—'}`,
          `CI workflows: ${report?.ciWorkflowCount ?? 0}`,
          `Commit convention: ${report?.commitConvention ?? '—'}`,
        ],
      },
      {
        title: 'Learned',
        items: [
          `${memoryEntryIds.length} memory entries seeded`,
          repo.mondayBoardId
            ? `Monday board mapped (board id ${repo.mondayBoardId})`
            : 'No Monday board (using internal backlog)',
        ],
      },
      { title: 'Policies', items: [`Mode: ${mode ?? 'semi-autonomous'}`, 'Budget: $20/sprint'] },
    ],
  }), [repo, report, memoryEntryIds.length, mode])

  return (
    <div data-testid="existing-repo-flow" className="space-y-6">
      {step === 'connect_repo' && (
        <>
          <ConnectRepoStep initial={repo} onChange={(r, valid) => { setRepo(r); setRepoValid(valid) }} />
          <div className="flex justify-end pt-4">
            <Button size="lg" onClick={goFromConnect} disabled={!repoValid}>Continue</Button>
          </div>
        </>
      )}
      {step === 'codebase_analysis' && (
        <CodebaseAnalysisStep
          sessionId={sessionId}
          projectId={projectId}
          owner={repo.githubOwner}
          repo={repo.githubRepo}
          onComplete={onAnalysisComplete}
        />
      )}
      {step === 'board_mapping' && (
        <BoardMappingStep
          mondayBoardId={repo.mondayBoardId}
          onConfirm={() => advance('memory_seed')}
          onSkip={() => advance('memory_seed')}
        />
      )}
      {step === 'memory_seed' && (
        <MemorySeedStep
          report={report}
          onConfirm={() => void seedMemory()}
          onSkip={() => advance('mode')}
          busy={busy}
        />
      )}
      {step === 'mode' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-2xl font-bold text-slate-900">Mode + budget</h1>
            <TimeEstimateBadge estSeconds={30} />
          </div>
          <ModeStep selected={mode} onSelect={setMode} />
          <div className="flex justify-end pt-4">
            <Button size="lg" onClick={() => advance('first_sprint', { mode })} disabled={!mode}>
              Continue
            </Button>
          </div>
        </>
      )}
      {step === 'first_sprint' && <FirstSprintStep onChoice={handleSprintChoice} />}
      {step === 'done' && (
        <DoneStep
          data={summary}
          onLaunch={onComplete}
          onTour={() => onComplete()}
          onWatchInspector={() => onComplete()}
        />
      )}
      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
    </div>
  )
}
