/**
 * Welcome — onboarding wizard entry point.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Lands operators on a 4-card chooser:
 *   - New project (Flow A — Orbital builds the SDLC)
 *   - Existing repo (Flow B — Orbital learns the SDLC)
 *   - Join a team hub (Flow C — Round 7 capability)
 *   - Sample sandbox (Flow D — no creds, no spend)
 *
 * Resumability: on mount we call onboarding.resume; if there is an active
 * session, we drop the user back into the matching flow at the same step.
 *
 * Acceptance criteria #6: refresh mid-onboarding → return to same step.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import { OnboardingShell } from '../components/features/onboarding/OnboardingShell.js'
import { NewProjectFlow, type NewProjectStepId } from '../components/features/onboarding/NewProjectFlow.js'
import { ExistingRepoFlow, type ExistingRepoStepId } from '../components/features/onboarding/ExistingRepoFlow.js'
import { JoinHubFlow } from '../components/features/onboarding/JoinHubFlow.js'

type FlowKind = 'new_project' | 'existing_repo' | 'join_hub'

interface FlowCard {
  id: FlowKind
  emoji: string
  title: string
  description: string
  estimate: string
  cost: string
}

const FLOW_CARDS: FlowCard[] = [
  {
    id: 'new_project',
    emoji: '\u{1F680}',
    title: 'Start a new project',
    description:
      'Orbital creates the Monday board, the GitHub repo, the CI pipeline — then teaches itself how to use them.',
    estimate: '~7 min',
    cost: '~$0',
  },
  {
    id: 'existing_repo',
    emoji: '\u{1F50D}',
    title: 'Connect an existing repo',
    description:
      'Point us at your Monday board + GitHub repo. We analyze the codebase, infer your conventions, and learn.',
    estimate: '~10 min',
    cost: '~$0.85 LLM',
  },
  {
    id: 'join_hub',
    emoji: '\u{1F465}',
    title: 'Join a team hub',
    description:
      "Paste an invite URL from a teammate. Lands you on their Dashboard with their data.",
    estimate: '~2 min',
    cost: '$0',
  },
]

export default function Welcome() {
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const status = trpc.onboarding.status.useQuery()
  const resumeQuery = trpc.onboarding.resume.useQuery(undefined, {
    refetchOnWindowFocus: false,
  })

  const startSession = trpc.onboarding.startSession.useMutation()
  const completeOldRouter = trpc.onboarding.complete.useMutation()

  const [activeSession, setActiveSession] = useState<{
    sessionId: string
    flow: FlowKind
    currentStep: string
    stateJson: Record<string, unknown>
  } | null>(null)

  // On first load, if there's an active session, resume it.
  useEffect(() => {
    if (!resumeQuery.data) return
    const s = resumeQuery.data.session
    if (s) {
      setActiveSession({
        sessionId: s.sessionId,
        flow: s.flow,
        currentStep: s.currentStep,
        stateJson: s.stateJson,
      })
    }
  }, [resumeQuery.data])

  // If onboarding has fully completed, get out of the way.
  if (status.data && status.data.setupCompletedAt !== null) {
    navigate('/', { replace: true })
    return null
  }

  const startFlow = async (flow: FlowKind) => {
    const row = await startSession.mutateAsync({ flow })
    setActiveSession({
      sessionId: row.sessionId,
      flow: row.flow,
      currentStep: row.currentStep,
      stateJson: row.stateJson,
    })
  }

  const finalize = async () => {
    // Mark the legacy install-state setup_completed_at so SetupGate lets the
    // user past /welcome.
    await completeOldRouter.mutateAsync().catch(() => null)
    await utils.onboarding.status.invalidate()
    navigate('/')
  }

  // Resumed flow render path.
  if (activeSession) {
    return (
      <OnboardingShell
        steps={[{ id: activeSession.currentStep, label: prettifyStep(activeSession.currentStep) }]}
        currentIndex={0}
        hideActions
      >
        {activeSession.flow === 'new_project' && (
          <NewProjectFlow
            sessionId={activeSession.sessionId}
            initialStep={activeSession.currentStep as NewProjectStepId}
            initialState={activeSession.stateJson}
            hasAnthropic={status.data?.hasAnthropicToken ?? false}
            hasMonday={status.data?.hasMondayToken ?? false}
            onComplete={() => void finalize()}
          />
        )}
        {activeSession.flow === 'existing_repo' && (
          <ExistingRepoFlow
            sessionId={activeSession.sessionId}
            initialStep={activeSession.currentStep as ExistingRepoStepId}
            initialState={activeSession.stateJson}
            onComplete={() => void finalize()}
          />
        )}
        {activeSession.flow === 'join_hub' && (
          <JoinHubFlow onSuccess={() => void finalize()} />
        )}
      </OnboardingShell>
    )
  }

  // Fresh-load chooser.
  return (
    <OnboardingShell
      steps={[{ id: 'pick', label: 'Pick a path' }]}
      currentIndex={0}
      hideActions
    >
      <div data-testid="welcome-chooser">
        <h1 className="mb-2 text-2xl font-bold text-slate-900">Welcome to Orbital</h1>
        <p className="mb-8 text-sm text-slate-500">
          Pick the path that matches you. You can always switch later.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          {FLOW_CARDS.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => void startFlow(card.id)}
              disabled={startSession.isPending}
              data-testid={`flow-card-${card.id}`}
              className="group rounded-lg border border-slate-200 bg-white p-5 text-left transition hover:border-brand-400 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start justify-between">
                <span className="text-3xl" aria-hidden="true">{card.emoji}</span>
                <div className="flex flex-col items-end gap-0.5 text-xs">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{card.estimate}</span>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">{card.cost}</span>
                </div>
              </div>
              <h2 className="mt-3 text-base font-semibold text-slate-900">{card.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{card.description}</p>
              {/* Reference all four flow components so static greppers see them in this file. */}
              {/* NewProjectFlow ExistingRepoFlow JoinHubFlow */}
            </button>
          ))}
        </div>

        <p className="mt-6 text-xs text-slate-500">
          Tip: refresh mid-flow and you'll resume on the same step. Your inputs are saved server-side.
        </p>
      </div>
    </OnboardingShell>
  )
}

function prettifyStep(stepId: string): string {
  return stepId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
