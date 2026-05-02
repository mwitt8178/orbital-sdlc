/**
 * Welcome — the onboarding wizard host page.
 *
 * Routes the user through 5 steps. Skips the Tokens step and the FirstVision
 * step when the chosen mode is Demo or Read-only. On completion, calls
 * onboarding.complete and forwards to /vision (live) or / (demo).
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { trpc } from '../services/trpc.js'
import type { OnboardingMode } from '../services/onboarding-types.js'
import {
  OnboardingShell,
  type ShellStep,
} from '../components/features/onboarding/OnboardingShell.js'
import { WelcomeStep } from '../components/features/onboarding/WelcomeStep.js'
import { ModeStep } from '../components/features/onboarding/ModeStep.js'
import { TokensStep } from '../components/features/onboarding/TokensStep.js'
import {
  PickStartStep,
  type StartChoice,
} from '../components/features/onboarding/PickStartStep.js'
import { FirstVisionStep } from '../components/features/onboarding/FirstVisionStep.js'

type StepId = 'welcome' | 'mode' | 'tokens' | 'pick-start' | 'first-vision'

interface StepDef extends ShellStep {
  id: StepId
}

const STEPS_LIVE: StepDef[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'mode', label: 'Mode' },
  { id: 'tokens', label: 'Connect' },
  { id: 'pick-start', label: 'Start' },
  { id: 'first-vision', label: 'Vision' },
]

const STEPS_DEMO: StepDef[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'mode', label: 'Mode' },
  { id: 'pick-start', label: 'Start' },
]

const STEPS_READONLY: StepDef[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'mode', label: 'Mode' },
  { id: 'pick-start', label: 'Start' },
]

export default function Welcome() {
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const status = trpc.onboarding.status.useQuery()

  const [stepIndex, setStepIndex] = useState(0)
  const [mode, setMode] = useState<OnboardingMode | null>(null)
  const [hasAnthropicSaved, setHasAnthropicSaved] = useState(false)
  const [hasMondaySaved, setHasMondaySaved] = useState(false)
  const [mondaySkipped, setMondaySkipped] = useState(false)
  const [startChoice, setStartChoice] = useState<StartChoice | null>(null)
  const [sampleLoadedAt, setSampleLoadedAt] = useState<string | null>(null)

  const setModeMutation = trpc.onboarding.setMode.useMutation()
  const loadSampleMutation = trpc.onboarding.loadSample.useMutation()
  const startDemoMutation = trpc.onboarding.startDemo.useMutation()
  const completeMutation = trpc.onboarding.complete.useMutation()

  const steps: StepDef[] =
    mode === 'live' ? STEPS_LIVE : mode === 'demo' ? STEPS_DEMO : mode === 'readonly' ? STEPS_READONLY : STEPS_LIVE

  const currentStep = steps[Math.min(stepIndex, steps.length - 1)] ?? STEPS_LIVE[0]!

  const canGoBack = stepIndex > 0
  const canResume = (status.data?.hasSampleData ?? false) || false

  // Continue button enabled state per step
  const canContinue = useMemo(() => {
    switch (currentStep.id) {
      case 'welcome':
        return true
      case 'mode':
        return mode !== null
      case 'tokens':
        return hasAnthropicSaved && (hasMondaySaved || mondaySkipped)
      case 'pick-start':
        return startChoice !== null
      case 'first-vision':
        return false // first-vision step submits internally
      default:
        return false
    }
  }, [currentStep.id, mode, hasAnthropicSaved, hasMondaySaved, mondaySkipped, startChoice])

  const goBack = () => setStepIndex((i) => Math.max(0, i - 1))

  const goForward = async () => {
    if (currentStep.id === 'mode' && mode) {
      await setModeMutation.mutateAsync({ mode })
      await utils.onboarding.status.invalidate()
    }

    if (currentStep.id === 'pick-start' && startChoice === 'sample') {
      const result = await loadSampleMutation.mutateAsync()
      setSampleLoadedAt(new Date().toISOString())
      if (mode === 'demo') {
        // Kick off the replay loop too so the user lands on a "live-feeling"
        // dashboard even without real agents.
        await startDemoMutation.mutateAsync({ speedMultiplier: 10 }).catch(() => null)
      }
      // ignore alreadyLoaded — landing on the dashboard is fine either way
      void result
    }

    // For demo / readonly modes, the wizard ends after pick-start.
    const isLastStep = stepIndex >= steps.length - 1
    if (isLastStep) {
      await finish()
      return
    }
    setStepIndex((i) => i + 1)
  }

  const finish = async () => {
    await completeMutation.mutateAsync()
    await utils.onboarding.status.invalidate()
    if (mode === 'live') {
      navigate('/vision')
    } else {
      navigate('/')
    }
  }

  // First-vision step: when the user starts a vision, mark setup complete and
  // forward to /vision.
  const onFirstVisionStarted = async () => {
    await finish()
  }

  // Already completed? Forward to /
  if (status.data && status.data.setupCompletedAt !== null) {
    navigate('/', { replace: true })
    return null
  }

  return (
    <OnboardingShell
      steps={steps}
      currentIndex={stepIndex}
      canGoBack={canGoBack}
      canContinue={canContinue}
      onBack={goBack}
      onContinue={goForward}
      hideActions={currentStep.id === 'first-vision'}
      continueLabel={
        currentStep.id === 'welcome'
          ? 'Get started →'
          : stepIndex === steps.length - 1
            ? 'Finish'
            : 'Continue'
      }
    >
      {currentStep.id === 'welcome' && <WelcomeStep />}
      {currentStep.id === 'mode' && <ModeStep selected={mode} onSelect={setMode} />}
      {currentStep.id === 'tokens' && (
        <TokensStep
          hasAnthropicSaved={hasAnthropicSaved || (status.data?.hasAnthropicToken ?? false)}
          hasMondaySaved={hasMondaySaved || (status.data?.hasMondayToken ?? false)}
          mondaySkipped={mondaySkipped}
          onSkipMonday={setMondaySkipped}
          onAnthropicSaved={() => setHasAnthropicSaved(true)}
          onMondaySaved={() => setHasMondaySaved(true)}
        />
      )}
      {currentStep.id === 'pick-start' && (
        <PickStartStep
          selected={startChoice}
          onSelect={setStartChoice}
          canResume={canResume}
          isLoadingSample={loadSampleMutation.isPending}
          sampleLoadedAt={sampleLoadedAt}
        />
      )}
      {currentStep.id === 'first-vision' && status.data && (
        <FirstVisionStep installId={status.data.installId} onStarted={onFirstVisionStarted} />
      )}
    </OnboardingShell>
  )
}
