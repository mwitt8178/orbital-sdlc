/**
 * Welcome — onboarding entry point, rebuilt.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { trpc } from '../services/trpc.js'
import { NewProjectFlow, type NewProjectStepId } from '../components/features/onboarding/NewProjectFlow.js'
import { ExistingRepoFlow, type ExistingRepoStepId } from '../components/features/onboarding/ExistingRepoFlow.js'
import { JoinHubFlow } from '../components/features/onboarding/JoinHubFlow.js'
import { OnboardingProgressBar } from '../components/features/onboarding/OnboardingProgressBar.js'
import { OrbitalMark } from '../components/onboarding/OrbitalMark.js'
import { Button } from '../components/ui/Button.js'
import { DURATION, EASE, fadeInUp } from '../components/onboarding/motion.js'
import { JOIN_HUB_STEPS, prettifyStepId } from '../components/features/onboarding/flow-steps.js'
import { useActiveProjectStore } from '../store/active-project.js'

type FlowKind = 'new_project' | 'existing_repo' | 'join_hub'

const FLOW_LABELS: Record<FlowKind, string> = {
  new_project: 'New project',
  existing_repo: 'Existing repo',
  join_hub: 'Team hub',
}

export default function Welcome() {
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const status = trpc.onboarding.status.useQuery()
  const resumeQuery = trpc.onboarding.resume.useQuery(undefined, {
    refetchOnWindowFocus: false,
  })

  const startSession = trpc.onboarding.startSession.useMutation()
  const completeOldRouter = trpc.onboarding.complete.useMutation()
  const abandon = trpc.onboarding.abandonSession.useMutation()

  const [activeSession, setActiveSession] = useState<{
    sessionId: string
    flow: FlowKind
    currentStep: string
    stateJson: Record<string, unknown>
  } | null>(null)
  const [resumed, setResumed] = useState(false)

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
    setResumed(true)
  }

  const setActiveProject = useActiveProjectStore((s) => s.setActiveProject)

  const finalize = async (projectId: string | null = null) => {
    if (projectId) {
      setActiveProject(projectId)
    }
    await completeOldRouter.mutateAsync().catch(() => null)
    await utils.onboarding.status.invalidate()
    await utils.projects.list.invalidate().catch(() => null)
    navigate('/')
  }

  const continueResumed = () => setResumed(true)

  const dropResumed = async () => {
    if (!activeSession) {
      setResumed(false)
      return
    }
    try {
      await abandon
        .mutateAsync({ sessionId: activeSession.sessionId, reason: 'user_abandoned' })
        .catch(() => null)
    } finally {
      setActiveSession(null)
      setResumed(false)
    }
  }

  // ---- Resumed flow render path — flow owns its own shell. ----
  if (activeSession && resumed) {
    if (activeSession.flow === 'new_project') {
      return (
        <NewProjectFlow
          sessionId={activeSession.sessionId}
          initialStep={activeSession.currentStep as NewProjectStepId}
          initialState={activeSession.stateJson}
          hasAnthropic={status.data?.hasAnthropicToken ?? false}
          hasMonday={status.data?.hasMondayToken ?? false}
          onComplete={(projectId) => void finalize(projectId)}
          onAbandon={() => void dropResumed()}
        />
      )
    }
    if (activeSession.flow === 'existing_repo') {
      return (
        <ExistingRepoFlow
          sessionId={activeSession.sessionId}
          initialStep={activeSession.currentStep as ExistingRepoStepId}
          initialState={activeSession.stateJson}
          onComplete={() => void finalize()}
          onAbandon={() => void dropResumed()}
        />
      )
    }
    return (
      <JoinHubShellWrapper onAbandon={() => void dropResumed()}>
        <JoinHubFlow onSuccess={() => void finalize()} />
      </JoinHubShellWrapper>
    )
  }

  return (
    <div className="hero-grid min-h-screen bg-surface-base" data-testid="welcome-chooser">
      {/* ---- Header ---- */}
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8 md:py-4">
          <div className="flex items-center gap-2.5">
            <OrbitalMark size={28} />
            <span className="text-sm font-semibold tracking-tight text-slate-900">Orbital</span>
          </div>
          <a
            href="https://orbital.dev/docs"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            Docs
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 md:px-8 md:pt-16">
        {/* ---- Resumed session banner ---- */}
        <AnimatePresence>
          {activeSession && !resumed && (
            <motion.section
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: DURATION.base, ease: EASE.out }}
              className="mb-8 flex flex-col gap-3 rounded-card-lg border border-brand-200 bg-brand-50/60 p-4 shadow-card md:flex-row md:items-center md:justify-between md:p-5"
              role="status"
              data-testid="resume-banner"
            >
              <div>
                <p className="text-sm font-semibold text-brand-800">You have an in-flight setup</p>
                <p className="mt-0.5 text-sm text-brand-700/90">
                  {FLOW_LABELS[activeSession.flow]} · paused at{' '}
                  <span className="font-medium">{prettifyStepId(activeSession.currentStep)}</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="md" onClick={() => void dropResumed()}>
                  Start over
                </Button>
                <Button size="md" onClick={continueResumed}>
                  Continue setup
                </Button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ---- Hero ---- */}
        <section className="grid gap-10 md:grid-cols-12 md:gap-8">
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            transition={{ duration: DURATION.slow, ease: EASE.out }}
            className="md:col-span-5"
          >
            <p className="mb-3 text-eyebrow font-semibold uppercase text-brand-700">
              Welcome to Orbital
            </p>
            <h1 className="text-display-xl text-slate-900">
              Ship a sprint by <span className="brand-gradient-text">end of day</span>.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600">
              Orbital wires up your board, your repo, your CI — and teaches a roster of agents how
              to actually work on your codebase. Pick the path that matches you. Setup takes
              between two and ten minutes.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-slate-600">
              {[
                'Real provisioning — Monday board, GitHub repo, CI workflow.',
                'Agents are taught your conventions, not generic ones.',
                'Skip any step and recover it later in Settings.',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </motion.div>

          {/* ---- Primary path card ---- */}
          <motion.div
            variants={fadeInUp}
            initial="hidden"
            animate="visible"
            transition={{ duration: DURATION.slow, ease: EASE.out, delay: 0.05 }}
            className="md:col-span-7"
          >
            <PrimaryFlowCard
              onStart={() => void startFlow('new_project')}
              busy={startSession.isPending}
            />
          </motion.div>
        </section>

        {/* ---- Secondary paths ---- */}
        <section className="mt-12 md:mt-16">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Or</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <SecondaryFlowCard
              testid="flow-card-existing_repo"
              onStart={() => void startFlow('existing_repo')}
              busy={startSession.isPending}
              title="Connect an existing repo"
              copy="Point us at your Monday board + GitHub repo. Orbital reads your stack, infers your conventions, and gets to work."
              estimate="≈ 10 min · ~$0.85 LLM"
              icon={<RepoIcon />}
            />
            <SecondaryFlowCard
              testid="flow-card-join_hub"
              onStart={() => void startFlow('join_hub')}
              busy={startSession.isPending}
              title="Join a team hub"
              copy="Paste an invite URL from a teammate to land directly on their workspace. No setup required."
              estimate="≈ 2 min · free"
              icon={<TeamIcon />}
            />
          </div>
        </section>

        <p className="mt-12 text-xs text-slate-500">
          Refresh mid-flow and you'll resume where you left off. Inputs are saved server-side
          after each step.
        </p>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Primary card — visually heavy
// ---------------------------------------------------------------------------

function PrimaryFlowCard({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={onStart}
      disabled={busy}
      data-testid="flow-card-new_project"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.99 }}
      transition={{ duration: 0.12, ease: EASE.out }}
      className="group relative w-full overflow-hidden rounded-card-lg border border-brand-200 bg-white p-6 text-left shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 md:p-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-brand-500/15 to-accent-500/10 blur-2xl"
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-card bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-glow-brand">
          <RocketIcon />
        </div>
        <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
          Recommended · ≈ 7 min
        </span>
      </div>
      <h3 className="relative mt-6 text-display-md text-slate-900">Start a new project</h3>
      <p className="relative mt-2 text-sm leading-relaxed text-slate-600">
        Orbital creates the Monday board, the GitHub repo, the CI pipeline — then teaches a roster
        of agents how to work on it. Best for greenfield work.
      </p>
      <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <li className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Monday board
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> GitHub repo
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> CI + webhooks
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Agent memory
          </li>
        </ul>
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-brand-700 transition-transform duration-150 group-hover:translate-x-0.5">
          {busy ? 'Starting…' : 'Start setup'}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </motion.button>
  )
}

function SecondaryFlowCard({
  onStart,
  busy,
  title,
  copy,
  estimate,
  icon,
  testid,
}: {
  onStart: () => void
  busy: boolean
  title: string
  copy: string
  estimate: string
  icon: React.ReactNode
  testid: string
}) {
  return (
    <motion.button
      type="button"
      onClick={onStart}
      disabled={busy}
      data-testid={testid}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.995 }}
      transition={{ duration: 0.12, ease: EASE.out }}
      className="group rounded-card-lg border border-slate-200 bg-white p-5 text-left shadow-card transition-colors hover:border-brand-300 hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-card bg-slate-100 text-slate-700">
          {icon}
        </div>
        <span className="text-xs font-medium text-slate-500">{estimate}</span>
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-600">{copy}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-transform duration-150 group-hover:translate-x-0.5">
        Start
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </span>
    </motion.button>
  )
}

function RocketIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.85-.85.92-2.18.16-3.16-.32-.4-.79-.69-1.32-.79a2.18 2.18 0 0 0-1.84.95Z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}

function RepoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </svg>
  )
}

function TeamIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// JoinHubShellWrapper — wraps the JoinHub flow (which owns no shell of its
// own) in the standard onboarding chrome.
// ---------------------------------------------------------------------------

function JoinHubShellWrapper({ onAbandon, children }: { onAbandon: () => void; children: React.ReactNode }) {
  return (
    <div className="hero-grid flex min-h-screen flex-col bg-surface-base">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 md:px-8 md:py-4">
          <div className="flex items-center gap-2.5">
            <OrbitalMark size={28} />
            <span className="text-sm font-semibold tracking-tight text-slate-900">Orbital</span>
          </div>
          <div className="hidden flex-1 justify-center md:flex">
            <OnboardingProgressBar steps={JOIN_HUB_STEPS} currentIndex={0} />
          </div>
          <button
            type="button"
            onClick={onAbandon}
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
            data-testid="switch-path"
          >
            Switch path
          </button>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 md:hidden">
          <OnboardingProgressBar steps={JOIN_HUB_STEPS} currentIndex={0} compact />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-12">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DURATION.base, ease: EASE.out }}
          className="rounded-card-lg border border-slate-200/80 bg-white p-5 shadow-card md:p-10 md:shadow-raised"
        >
          <div className="mb-6">
            <h1 className="text-display-md text-slate-900">Join a team hub</h1>
            <p className="mt-2 text-sm text-slate-600">
              Paste an invite URL from a teammate. We'll connect this laptop to their workspace.
            </p>
          </div>
          {children}
        </motion.div>
      </main>
    </div>
  )
}

