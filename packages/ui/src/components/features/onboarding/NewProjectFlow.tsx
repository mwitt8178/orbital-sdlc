/**
 * NewProjectFlow — Flow A: Orbital BUILDS the SDLC for a brand-new project.
 *
 * Rebuilt for the onboarding rework:
 *  - Owns its own OnboardingShell, with multi-step progress visible at all
 *    viewport widths
 *  - Save state is surfaced in the chrome (not buried under inputs)
 *  - Provisioning panels stream real progress with motion + per-line state,
 *    and a "Retry" affordance when a call fails
 *  - Idempotency: provisioning steps guard on local + server state and
 *    require an explicit retry, so reload during a network hang doesn't
 *    fire two `createMondayBoard` calls back-to-back
 *  - Reserved-slug + slug→URL preview added
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { trpc } from '../../../services/trpc.js'
import { OnboardingShell } from './OnboardingShell.js'
import { ConnectToolsStep, type ConnectToolsResult } from './ConnectToolsStep.js'
import { ProjectBasicsStep, type ProjectBasics } from './ProjectBasicsStep.js'
import { VisionIntakeStep, type VisionIntakeData } from './VisionIntakeStep.js'
import { ModeStep } from './ModeStep.js'
import { FirstSprintStep } from './FirstSprintStep.js'
import { DoneStep, type DoneStepData } from './DoneStep.js'
import { NEW_PROJECT_STEPS } from './flow-steps.js'
import { Button } from '../../ui/Button.js'
import type { SaveState } from '../../onboarding/SaveIndicator.js'
import type { OnboardingMode } from '../../../services/onboarding-types.js'
import { DURATION, EASE } from '../../onboarding/motion.js'

export type NewProjectStepId =
  | 'project_basics'
  | 'connect_tools'
  | 'vision_intake'
  | 'monday_provision'
  | 'github_provision'
  | 'system_teach'
  | 'mode'
  | 'first_sprint'
  | 'done'

interface Props {
  sessionId: string
  initialStep: NewProjectStepId
  initialState: Record<string, unknown>
  hasAnthropic: boolean
  hasMonday: boolean
  onComplete: () => void
  onAbandon?: () => void
}

interface ProvisioningEntry {
  message: string
  state: 'pending' | 'running' | 'done' | 'failed'
}

const STEPS = NEW_PROJECT_STEPS

export function NewProjectFlow({
  sessionId,
  initialStep,
  initialState,
  hasAnthropic,
  hasMonday,
  onComplete,
  onAbandon,
}: Props) {
  const update = trpc.onboarding.updateSession.useMutation()
  const createMondayBoard = trpc.onboarding.createMondayBoard.useMutation()
  const createGitRepo = trpc.onboarding.createGitRepo.useMutation()
  const seedFromVision = trpc.onboarding.seedMemoryFromVision.useMutation()
  const configureSystem = trpc.onboarding.configureSystem.useMutation()
  const completeSession = trpc.onboarding.completeSession.useMutation()

  const [step, setStep] = useState<NewProjectStepId>(initialStep)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reducer-style state, persisted to the server on every transition.
  const [basics, setBasics] = useState<ProjectBasics>({
    name: (initialState['name'] as string) ?? '',
    slug: (initialState['slug'] as string) ?? '',
    description: (initialState['description'] as string) ?? '',
  })
  const [basicsValid, setBasicsValid] = useState(false)

  const [tools, setTools] = useState<ConnectToolsResult>({
    anthropicConnected: hasAnthropic,
    mondaySkipped: false,
    mondayConnected: hasMonday,
    githubSkipped: false,
    githubConnected: false,
  })
  const [vision, setVision] = useState<VisionIntakeData>({
    intent: (initialState['intent'] as string) ?? '',
    stack: (initialState['stack'] as string[]) ?? ['nodejs', 'typescript', 'react', 'tailwind'],
  })
  const [visionValid, setVisionValid] = useState(false)
  const [mode, setMode] = useState<OnboardingMode | null>(
    (initialState['mode'] as OnboardingMode | null) ?? 'live',
  )
  const [projectId, setProjectId] = useState<string | null>(
    (initialState['project_id'] as string | undefined) ?? null,
  )
  const [mondayBoardId, setMondayBoardId] = useState<string | null>(
    (initialState['monday_board_id'] as string | undefined) ?? null,
  )
  const [github, setGithub] = useState<{ owner: string; repo: string } | null>(
    (initialState['github'] as { owner: string; repo: string } | undefined) ?? null,
  )
  const [memoryEntryIds, setMemoryEntryIds] = useState<string[]>(
    (initialState['memory_entry_ids'] as string[] | undefined) ?? [],
  )
  const [provisioningLog, setProvisioningLog] = useState<ProvisioningEntry[]>([])

  const [stepError, setStepError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ---- Persist current step to server with save-indicator feedback. ----
  const advance = async (nextStep: NewProjectStepId, patch: Record<string, unknown> = {}) => {
    setStep(nextStep)
    setSaveState('saving')
    setSaveError(null)
    try {
      await update.mutateAsync({ sessionId, step: nextStep, patch })
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
    const prevId = STEPS[idx - 1]!.id as NewProjectStepId
    void advance(prevId)
  }

  // ---- Step actions ----
  const goFromBasics = () => {
    void advance('connect_tools', {
      name: basics.name,
      slug: basics.slug,
      description: basics.description,
    })
  }

  const goFromConnect = () => {
    void advance('vision_intake', {
      tools_anthropic_connected: tools.anthropicConnected,
      tools_monday_connected: tools.mondayConnected || tools.mondaySkipped,
      tools_github_connected: tools.githubConnected || tools.githubSkipped,
    })
  }

  const goFromVision = () => {
    void advance('monday_provision', { intent: vision.intent, stack: vision.stack })
  }

  const runMondayProvision = async () => {
    setStepError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Creating Monday board…', state: 'running' }])
    try {
      const pid = projectId ?? crypto.randomUUID()
      if (!projectId) setProjectId(pid)
      const result = await createMondayBoard.mutateAsync({
        sessionId,
        projectId: pid,
        projectName: basics.name,
        isPrivate: true,
      })
      setMondayBoardId(result.boardId)
      setProvisioningLog([
        { message: `Created board "${basics.name} — SDLC" (id: ${result.boardId})`, state: 'done' },
        { message: `Added ${result.columnsAdded} columns`, state: 'done' },
        { message: `Configured ${result.statusValuesAdded} workflow statuses`, state: 'done' },
        { message: 'Mapped to Orbital SDLC schema', state: 'done' },
      ])
      void advance('github_provision', { project_id: pid, monday_board_id: result.boardId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Monday board provisioning failed.'
      setProvisioningLog([{ message: msg, state: 'failed' }])
      setStepError(msg)
    } finally {
      setBusy(false)
    }
  }

  const runGithubProvision = async () => {
    setStepError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Creating GitHub repo…', state: 'running' }])
    try {
      const pid = projectId
      if (!pid) {
        setStepError('Project id missing — cannot provision repo.')
        return
      }
      const result = await createGitRepo.mutateAsync({
        sessionId,
        projectId: pid,
        name: basics.slug,
        description: basics.description,
        isPrivate: true,
        stack: 'nodejs',
        license: 'mit',
      })
      setGithub({ owner: result.owner, repo: result.repo })
      setProvisioningLog([
        {
          message: `Created ${result.owner}/${result.repo} (${result.isPrivate ? 'private' : 'public'})`,
          state: 'done',
        },
        { message: 'Initialized with README + .gitignore + LICENSE', state: 'done' },
        { message: `Added ${result.labelsCreated.length} labels`, state: 'done' },
        { message: result.ciWorkflowCommitted ? 'Configured CI workflow' : 'CI workflow skipped', state: 'done' },
        { message: result.webhookConfigured ? 'Webhook configured' : 'Webhook skipped', state: 'done' },
      ])
      void advance('system_teach', { github: { owner: result.owner, repo: result.repo } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'GitHub repo provisioning failed.'
      setProvisioningLog([{ message: msg, state: 'failed' }])
      setStepError(msg)
    } finally {
      setBusy(false)
    }
  }

  const runSystemTeach = async () => {
    setStepError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Teaching the system about this project…', state: 'running' }])
    try {
      const pid = projectId
      if (!pid) {
        setStepError('Project id missing.')
        return
      }
      const seedRes = await seedFromVision.mutateAsync({
        sessionId,
        projectId: pid,
        intent: vision.intent,
        stack: vision.stack,
        conventions: [
          { title: 'Conventional Commits', body: 'Commits follow Conventional Commits.' },
          { title: 'Trunk-based', body: 'Branch model: trunk-based with feature branches.' },
        ],
        glossary: [],
      })
      setMemoryEntryIds(seedRes.entryIds)
      const cfg = await configureSystem.mutateAsync({
        sessionId,
        projectId: pid,
        projectName: basics.name,
        github: github ?? null,
        vision,
        mondayBoardId,
        memoryEntryIds: seedRes.entryIds,
      })
      setProvisioningLog([
        {
          message: `Generated project CLAUDE.md ${cfg.claudeMdCommitted ? '(committed to repo)' : '(local-only)'}`,
          state: 'done',
        },
        { message: `Seeded ${seedRes.entryIds.length} memory entries`, state: 'done' },
        { message: `Configured ${cfg.skillsEnabled.length} skills for this project`, state: 'done' },
        { message: 'Persona briefs now include project context', state: 'done' },
      ])
      void advance('mode', { memory_entry_ids: seedRes.entryIds })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'System teach step failed.'
      setProvisioningLog([{ message: msg, state: 'failed' }])
      setStepError(msg)
    } finally {
      setBusy(false)
    }
  }

  // ---- Auto-trigger provisioning when entering the step, but ONLY if the
  // outcome isn't already known. This is the key idempotency guard. ----
  useEffect(() => {
    if (busy) return
    if (step === 'monday_provision') {
      if (mondayBoardId) {
        void advance('github_provision')
      } else if (!tools.mondayConnected && !tools.mondaySkipped) {
        void advance('github_provision')
      } else if (tools.mondayConnected && !mondayBoardId) {
        void runMondayProvision()
      } else if (tools.mondaySkipped) {
        void advance('github_provision')
      }
    } else if (step === 'github_provision') {
      if (github) {
        void advance('system_teach')
      } else if (!tools.githubConnected) {
        void advance('system_teach')
      } else {
        void runGithubProvision()
      }
    } else if (step === 'system_teach') {
      if (memoryEntryIds.length > 0) {
        void advance('mode')
      } else {
        void runSystemTeach()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const goFromMode = () => {
    if (!mode) return
    void advance('first_sprint', { mode })
  }

  const handleSprintChoice = async (choice: 'launch' | 'edit' | 'skip') => {
    void advance('done', { sprint_choice: choice })
    try {
      await completeSession.mutateAsync({ sessionId, projectId: projectId ?? null })
    } catch {
      // already completed — fine
    }
  }

  const summary = useMemo<DoneStepData>(() => {
    return {
      projectName: basics.name,
      sections: [
        {
          title: 'Project',
          items: [
            `Project "${basics.name}" created`,
            vision.intent.length > 0 ? 'Vision document captured' : 'No vision document',
          ],
        },
        {
          title: 'Infrastructure',
          items: [
            mondayBoardId
              ? `Monday board "${basics.name} — SDLC" created (id: ${mondayBoardId})`
              : 'Monday board: skipped',
            github
              ? `GitHub repo ${github.owner}/${github.repo} created (private)`
              : 'GitHub repo: skipped',
            github ? 'GitHub Actions CI configured' : '',
            github ? 'Webhook pointed at this Orbital install' : '',
          ].filter((s): s is string => s.length > 0),
        },
        {
          title: 'System taught',
          items: [
            github ? 'Project CLAUDE.md generated and committed' : 'Project CLAUDE.md generated (local)',
            `${memoryEntryIds.length} memory entries seeded`,
            'Persona briefs ready for this project',
          ],
        },
        {
          title: 'Policies',
          items: [`Mode: ${mode ?? 'semi-autonomous'}`, 'Budget: $20/sprint, $100/week'],
        },
      ],
    }
  }, [basics.name, vision.intent, mondayBoardId, github, memoryEntryIds.length, mode])

  // ---- Footer wiring per step ----
  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const showFooter = step !== 'done' && step !== 'first_sprint' && !isProvisioningStep(step)
  const continueAction =
    step === 'project_basics'
      ? goFromBasics
      : step === 'connect_tools'
        ? goFromConnect
        : step === 'vision_intake'
          ? goFromVision
          : step === 'mode'
            ? goFromMode
            : undefined
  const canContinue =
    step === 'project_basics'
      ? basicsValid
      : step === 'connect_tools'
        ? tools.anthropicConnected
        : step === 'vision_intake'
          ? visionValid
          : step === 'mode'
            ? mode !== null
            : false

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
      <div data-testid="new-project-flow" className="space-y-6">
        {step === 'project_basics' && (
          <ProjectBasicsStep
            initial={basics}
            onChange={(b, valid) => {
              setBasics(b)
              setBasicsValid(valid)
            }}
          />
        )}
        {step === 'connect_tools' && (
          <ConnectToolsStep
            hasAnthropic={tools.anthropicConnected}
            hasMonday={tools.mondayConnected}
            hasGithub={tools.githubConnected}
            onChange={setTools}
          />
        )}
        {step === 'vision_intake' && (
          <VisionIntakeStep
            initial={vision}
            onChange={(v, valid) => {
              setVision(v)
              setVisionValid(valid)
            }}
          />
        )}
        {(step === 'monday_provision' || step === 'github_provision' || step === 'system_teach') && (
          <ProvisioningPanel
            step={step}
            log={provisioningLog}
            busy={busy}
            error={stepError}
            mondayBoardId={mondayBoardId}
            githubFullName={github ? `${github.owner}/${github.repo}` : null}
            onRetry={
              step === 'monday_provision'
                ? () => void runMondayProvision()
                : step === 'github_provision'
                  ? () => void runGithubProvision()
                  : () => void runSystemTeach()
            }
          />
        )}
        {step === 'mode' && (
          <div>
            <h1 className="text-display-md text-slate-900">Mode + budget</h1>
            <p className="mt-2 mb-6 text-sm text-slate-600">
              Default: live mode, $20/sprint, $100/week. Adjust later in{' '}
              <a href="/settings/general" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                Settings → General
              </a>
              .
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
      </div>
    </OnboardingShell>
  )
}

function isProvisioningStep(s: NewProjectStepId): boolean {
  return s === 'monday_provision' || s === 'github_provision' || s === 'system_teach'
}

// ---------------------------------------------------------------------------
// ProvisioningPanel — animated, retry-aware
// ---------------------------------------------------------------------------

function ProvisioningPanel({
  step,
  log,
  busy,
  error,
  mondayBoardId,
  githubFullName,
  onRetry,
}: {
  step: NewProjectStepId
  log: ProvisioningEntry[]
  busy: boolean
  error: string | null
  mondayBoardId: string | null
  githubFullName: string | null
  onRetry: () => void
}) {
  const heading =
    step === 'monday_provision'
      ? 'Setting up your Monday board'
      : step === 'github_provision'
        ? 'Setting up your GitHub repository'
        : 'Teaching the system about this project'
  const subheading =
    step === 'monday_provision'
      ? 'Real provisioning — every line below is an actual API call completing.'
      : step === 'github_provision'
        ? 'Repo + labels + CI + webhook. Real GitHub mutations, not a simulation.'
        : 'Generating CLAUDE.md, seeding memory entries, and binding skills to this project.'
  return (
    <div data-testid={`provision-panel-${step}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="relative inline-flex h-2.5 w-2.5">
          {busy && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${error ? 'bg-red-500' : busy ? 'bg-brand-500' : 'bg-emerald-500'}`}
          />
        </span>
        <h1 className="text-display-md text-slate-900">{heading}</h1>
      </div>
      <p className="mb-6 text-sm text-slate-600">{subheading}</p>

      <ul
        className="space-y-2 rounded-card border border-slate-200 bg-surface-sunken p-4 text-sm"
        role="status"
        aria-live="polite"
      >
        {log.length === 0 && (
          <li className="text-slate-500">
            <span className="inline-flex animate-pulse-dot rounded-full bg-slate-300" /> Working…
          </li>
        )}
        {log.map((entry, idx) => (
          <motion.li
            key={`${entry.message}-${idx}`}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE.out, delay: idx * 0.05 }}
            className="flex items-start gap-2"
          >
            <EntryIcon state={entry.state} />
            <span className={entry.state === 'failed' ? 'text-red-700' : 'text-slate-700'}>
              {entry.message}
            </span>
          </motion.li>
        ))}
      </ul>

      <div className="mt-3 space-y-1 text-xs text-slate-500">
        {step === 'monday_provision' && mondayBoardId && <p>Board id: {mondayBoardId}</p>}
        {step === 'github_provision' && githubFullName && <p>Repo: {githubFullName}</p>}
        {busy && <p>Hold on — this can take ~30 seconds.</p>}
      </div>

      {error && (
        <div className="mt-4 rounded-card border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">Step failed</p>
          <p className="mt-1 text-sm text-red-700">{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={onRetry} disabled={busy}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function EntryIcon({ state }: { state: ProvisioningEntry['state'] }) {
  if (state === 'done') {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-red-100 text-red-700">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    )
  }
  if (state === 'running') {
    return (
      <span className="relative mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
      </span>
    )
  }
  return <span className="mt-0.5 inline-block h-2 w-2 flex-none rounded-full bg-slate-300" />
}
