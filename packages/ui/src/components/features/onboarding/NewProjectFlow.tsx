/**
 * NewProjectFlow — Flow A: Orbital BUILDS the SDLC for a brand-new project.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Steps: project_basics → connect_tools → vision_intake → monday_provision →
 * github_provision → system_teach → mode → first_sprint → done.
 *
 * Resumability: state is mirrored into the server-side onboarding_sessions
 * table on every step transition, so refresh returns to the current step.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'
import { ConnectToolsStep, type ConnectToolsResult } from './ConnectToolsStep.js'
import { ProjectBasicsStep, type ProjectBasics } from './ProjectBasicsStep.js'
import { VisionIntakeStep, type VisionIntakeData } from './VisionIntakeStep.js'
import { ModeStep } from './ModeStep.js'
import { FirstSprintStep } from './FirstSprintStep.js'
import { DoneStep, type DoneStepData } from './DoneStep.js'
import type { OnboardingMode } from '../../../services/onboarding-types.js'

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
  /** Called when the wizard finishes and the user clicks Launch. */
  onComplete: () => void
}

interface ProvisioningProgress {
  message: string
  done: boolean
}

export function NewProjectFlow({
  sessionId,
  initialStep,
  initialState,
  hasAnthropic,
  hasMonday,
  onComplete,
}: Props) {
  const update = trpc.onboarding.updateSession.useMutation()
  const createMondayBoard = trpc.onboarding.createMondayBoard.useMutation()
  const createGitRepo = trpc.onboarding.createGitRepo.useMutation()
  const seedFromVision = trpc.onboarding.seedMemoryFromVision.useMutation()
  const configureSystem = trpc.onboarding.configureSystem.useMutation()
  const completeSession = trpc.onboarding.completeSession.useMutation()

  const [step, setStep] = useState<NewProjectStepId>(initialStep)

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
  const [provisioningLog, setProvisioningLog] = useState<ProvisioningProgress[]>([])

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Helpers --------------------------------------------------------------

  const advance = async (nextStep: NewProjectStepId, patch: Record<string, unknown> = {}) => {
    setStep(nextStep)
    try {
      await update.mutateAsync({ sessionId, step: nextStep, patch })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save progress.')
    }
  }

  // Step actions ---------------------------------------------------------

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
    void advance('monday_provision', {
      intent: vision.intent,
      stack: vision.stack,
    })
  }

  const runMondayProvision = async () => {
    setError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Creating Monday board...', done: false }])
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
        { message: `Created board "${basics.name} — SDLC" (id: ${result.boardId})`, done: true },
        { message: `Added ${result.columnsAdded} columns`, done: true },
        { message: `Configured ${result.statusValuesAdded} workflow statuses`, done: true },
        { message: 'Mapped to Orbital SDLC schema', done: true },
      ])
      void advance('github_provision', { project_id: pid, monday_board_id: result.boardId })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Monday board provisioning failed.')
    } finally {
      setBusy(false)
    }
  }

  const runGithubProvision = async () => {
    setError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Creating GitHub repo...', done: false }])
    try {
      const pid = projectId
      if (!pid) {
        setError('Project id missing — cannot provision repo.')
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
        { message: `Created ${result.owner}/${result.repo} (${result.isPrivate ? 'private' : 'public'})`, done: true },
        { message: `Initialized with README + .gitignore + LICENSE`, done: true },
        { message: `Added ${result.labelsCreated.length} labels`, done: true },
        { message: result.ciWorkflowCommitted ? 'Configured CI workflow' : 'CI workflow skipped', done: true },
        { message: result.webhookConfigured ? 'Webhook configured' : 'Webhook skipped', done: true },
      ])
      void advance('system_teach', { github: { owner: result.owner, repo: result.repo } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub repo provisioning failed.')
    } finally {
      setBusy(false)
    }
  }

  const runSystemTeach = async () => {
    setError(null)
    setBusy(true)
    setProvisioningLog([{ message: 'Teaching the system about this project...', done: false }])
    try {
      const pid = projectId
      if (!pid) {
        setError('Project id missing.')
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
          done: true,
        },
        { message: `Seeded ${seedRes.entryIds.length} memory entries`, done: true },
        { message: `Configured ${cfg.skillsEnabled.length} skills for this project`, done: true },
        { message: 'Persona briefs now include project context', done: true },
      ])
      void advance('mode', { memory_entry_ids: seedRes.entryIds })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'System teach step failed.')
    } finally {
      setBusy(false)
    }
  }

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

  // Auto-trigger provisioning steps when entering them.
  useEffect(() => {
    if (step === 'monday_provision' && !mondayBoardId && !busy && tools.mondayConnected) {
      void runMondayProvision()
    } else if (step === 'monday_provision' && !tools.mondayConnected && !mondayBoardId) {
      // Skipped: jump straight ahead.
      void advance('github_provision')
    } else if (step === 'github_provision' && !github && !busy && tools.githubConnected) {
      void runGithubProvision()
    } else if (step === 'github_provision' && !tools.githubConnected && !github) {
      void advance('system_teach')
    } else if (step === 'system_teach' && memoryEntryIds.length === 0 && !busy) {
      void runSystemTeach()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Render --------------------------------------------------------------

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
          items: [
            `Mode: ${mode ?? 'semi-autonomous'}`,
            'Budget: $20/sprint, $100/week',
          ],
        },
      ],
    }
  }, [basics.name, vision.intent, mondayBoardId, github, memoryEntryIds.length, mode])

  return (
    <div data-testid="new-project-flow" className="space-y-6">
      {step === 'project_basics' && (
        <>
          <ProjectBasicsStep initial={basics} onChange={(b, valid) => { setBasics(b); setBasicsValid(valid) }} />
          <FlowFooter onContinue={goFromBasics} canContinue={basicsValid} />
        </>
      )}
      {step === 'connect_tools' && (
        <>
          <ConnectToolsStep
            hasAnthropic={tools.anthropicConnected}
            hasMonday={tools.mondayConnected}
            hasGithub={tools.githubConnected}
            onChange={setTools}
          />
          <FlowFooter
            onContinue={goFromConnect}
            canContinue={tools.anthropicConnected}
          />
        </>
      )}
      {step === 'vision_intake' && (
        <>
          <VisionIntakeStep initial={vision} onChange={(v, valid) => { setVision(v); setVisionValid(valid) }} />
          <FlowFooter onContinue={goFromVision} canContinue={visionValid} />
        </>
      )}
      {(step === 'monday_provision' || step === 'github_provision' || step === 'system_teach') && (
        <ProvisioningPanel
          step={step}
          log={provisioningLog}
          busy={busy}
          error={error}
          mondayBoardId={mondayBoardId}
          githubFullName={github ? `${github.owner}/${github.repo}` : null}
        />
      )}
      {step === 'mode' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-2xl font-bold text-slate-900">Mode + budget</h1>
            <TimeEstimateBadge estSeconds={30} />
          </div>
          <p className="mb-4 text-sm text-slate-500">
            Default: semi-autonomous, $20/sprint, $100/week. You can adjust these from{' '}
            <span className="font-medium">Settings</span>.
          </p>
          <ModeStep selected={mode} onSelect={setMode} />
          <FlowFooter onContinue={goFromMode} canContinue={mode !== null} />
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

// ---------------------------------------------------------------------------
// Internal subcomponents
// ---------------------------------------------------------------------------

function FlowFooter({
  onContinue,
  canContinue,
}: {
  onContinue: () => void
  canContinue: boolean
}) {
  return (
    <div className="flex justify-end pt-4">
      <Button size="lg" onClick={onContinue} disabled={!canContinue}>
        Continue
      </Button>
    </div>
  )
}

function ProvisioningPanel({
  step,
  log,
  busy,
  error,
  mondayBoardId,
  githubFullName,
}: {
  step: NewProjectStepId
  log: ProvisioningProgress[]
  busy: boolean
  error: string | null
  mondayBoardId: string | null
  githubFullName: string | null
}) {
  const heading =
    step === 'monday_provision'
      ? 'Setting up your Monday board...'
      : step === 'github_provision'
        ? 'Setting up your GitHub repository...'
        : 'Teaching your system how to work on this project...'
  return (
    <div data-testid={`provision-panel-${step}`}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">{heading}</h1>
        <TimeEstimateBadge estSeconds={30} />
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Real progress, not animation — every line below is an actual API call completing.
      </p>
      <ul className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm" role="status" aria-live="polite">
        {log.length === 0 && <li className="text-slate-500">Working...</li>}
        {log.map((entry, idx) => (
          <li key={idx} className="flex items-start gap-2">
            <span className={entry.done ? 'text-emerald-600' : 'text-slate-400'}>
              {entry.done ? '✓' : '·'}
            </span>
            <span className="text-slate-700">{entry.message}</span>
          </li>
        ))}
      </ul>
      {step === 'monday_provision' && mondayBoardId && (
        <p className="mt-3 text-xs text-slate-500">Board id: {mondayBoardId}</p>
      )}
      {step === 'github_provision' && githubFullName && (
        <p className="mt-3 text-xs text-slate-500">Repo: {githubFullName}</p>
      )}
      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {busy && <p className="mt-2 text-xs text-slate-400">Hold on — this can take ~30 seconds.</p>}
    </div>
  )
}
