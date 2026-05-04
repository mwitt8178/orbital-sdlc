/**
 * ExistingRepoFlow — Flow B: Orbital LEARNS from an existing repo.
 *
 * Rebuilt for the onboarding rework: shell-aware, save-state surfaced,
 * back-nav, abandon affordance.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { OnboardingShell } from './OnboardingShell.js'
import { ConnectRepoStep, type ConnectRepoData } from './ConnectRepoStep.js'
import { CodebaseAnalysisStep, type AnalysisReport } from './CodebaseAnalysisStep.js'
import { BoardMappingStep } from './BoardMappingStep.js'
import { MemorySeedStep } from './MemorySeedStep.js'
import { ModeStep } from './ModeStep.js'
import { FirstSprintStep } from './FirstSprintStep.js'
import { DoneStep, type DoneStepData } from './DoneStep.js'
import { EXISTING_REPO_STEPS } from './flow-steps.js'
import type { SaveState } from '../../onboarding/SaveIndicator.js'
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
  onAbandon?: () => void
}

const STEPS = EXISTING_REPO_STEPS

export function ExistingRepoFlow({ sessionId, initialStep, initialState, onComplete, onAbandon }: Props) {
  const update = trpc.onboarding.updateSession.useMutation()
  const seedFromAnalysis = trpc.onboarding.seedMemoryFromAnalysis.useMutation()
  const configureSystem = trpc.onboarding.configureSystem.useMutation()
  const completeSession = trpc.onboarding.completeSession.useMutation()

  const [step, setStep] = useState<ExistingRepoStepId>(initialStep)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [repo, setRepo] = useState<ConnectRepoData>({
    githubOwner: (initialState['github_owner'] as string) ?? '',
    githubRepo: (initialState['github_repo'] as string) ?? '',
    mondayBoardId: (initialState['monday_board_id'] as string) ?? '',
  })
  const [repoValid, setRepoValid] = useState(false)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [memoryEntryIds, setMemoryEntryIds] = useState<string[]>([])
  const [mode, setMode] = useState<OnboardingMode | null>('live')
  const [projectId] = useState<string>(
    (initialState['project_id'] as string | undefined) ?? crypto.randomUUID(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const advance = async (next: ExistingRepoStepId, patch: Record<string, unknown> = {}) => {
    setStep(next)
    setSaveState('saving')
    setSaveError(null)
    try {
      await update.mutateAsync({ sessionId, step: next, patch })
      setSaveState('saved')
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1200)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : 'Could not save progress.')
    }
  }

  const back = () => {
    const idx = STEPS.findIndex((s) => s.id === step)
    if (idx <= 0) return
    void advance(STEPS[idx - 1]!.id as ExistingRepoStepId)
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
      /* already completed */
    }
  }

  const summary = useMemo<DoneStepData>(
    () => ({
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
    }),
    [repo, report, memoryEntryIds.length, mode],
  )

  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const showFooter = step === 'connect_repo' || step === 'mode'
  const continueAction =
    step === 'connect_repo' ? goFromConnect : step === 'mode' ? () => advance('first_sprint', { mode }) : undefined
  const canContinue = step === 'connect_repo' ? repoValid : step === 'mode' ? mode !== null : false

  return (
    <OnboardingShell
      steps={STEPS}
      currentIndex={stepIndex < 0 ? 0 : stepIndex}
      hideActions={!showFooter}
      onContinue={continueAction}
      canContinue={canContinue}
      onBack={back}
      canGoBack={stepIndex > 0 && !busy}
      saveState={saveState}
      saveError={saveError}
      secondaryAction={onAbandon ? { label: 'Switch path', onClick: onAbandon } : null}
    >
      <div data-testid="existing-repo-flow" className="space-y-6">
        {step === 'connect_repo' && (
          <ConnectRepoStep
            initial={repo}
            onChange={(r, valid) => {
              setRepo(r)
              setRepoValid(valid)
            }}
          />
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
          <div>
            <h1 className="text-display-md text-slate-900">Mode + budget</h1>
            <p className="mt-2 mb-6 text-sm text-slate-600">
              Pick how aggressive Orbital is on this codebase. Adjust later in Settings → General.
            </p>
            <ModeStep selected={mode} onSelect={setMode} />
          </div>
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
        {error && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </OnboardingShell>
  )
}
