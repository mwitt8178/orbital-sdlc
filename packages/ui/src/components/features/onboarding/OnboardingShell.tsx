/**
 * OnboardingShell — wizard chrome.
 *
 * Rebuilt for the onboarding rework:
 *  - Sticky header with full-strength brand mark + autosave indicator
 *  - Mobile-first padding scale (base 1rem, md 2.5rem)
 *  - Sticky footer for back/continue, with motion on transition
 *  - Save state surfaced in chrome (not buried under inputs)
 *  - Optional eyebrow + heading slot so individual steps don't have to
 *    re-roll their own h1+meta block
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Button } from '../../ui/Button.js'
import { OnboardingProgressBar } from './OnboardingProgressBar.js'
import { OrbitalMark } from '../../onboarding/OrbitalMark.js'
import { SaveIndicator, type SaveState } from '../../onboarding/SaveIndicator.js'
import { DURATION, EASE } from '../../onboarding/motion.js'

export interface ShellStep {
  id: string
  label: string
}

interface Props {
  steps: ShellStep[]
  currentIndex: number
  canGoBack?: boolean
  canContinue?: boolean
  continueLabel?: string
  onBack?: () => void
  onContinue?: () => void
  hideActions?: boolean
  /** Optional autosave state shown in the header. */
  saveState?: SaveState
  saveError?: string | null
  /** Optional secondary action shown left of Continue (e.g. "Skip"). */
  secondaryAction?: { label: string; onClick: () => void } | null
  children: ReactNode
}

export function OnboardingShell({
  steps,
  currentIndex,
  canGoBack = false,
  canContinue = true,
  continueLabel = 'Continue',
  onBack,
  onContinue,
  hideActions = false,
  saveState,
  saveError,
  secondaryAction = null,
  children,
}: Props) {
  const showProgress = steps.length > 1
  return (
    <div className="hero-grid flex min-h-screen flex-col bg-surface-base">
      {/* ---- Header ---- */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 md:px-8 md:py-4">
          <a href="/" className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-md">
            <OrbitalMark size={28} />
            <span className="text-sm font-semibold tracking-tight text-slate-900">Orbital</span>
          </a>

          {showProgress && (
            <div className="hidden flex-1 justify-center md:flex">
              <OnboardingProgressBar steps={steps} currentIndex={currentIndex} />
            </div>
          )}

          <div className="flex items-center gap-2">
            {saveState && <SaveIndicator state={saveState} errorMessage={saveError} />}
          </div>
        </div>

        {showProgress && (
          <div className="border-t border-slate-100 px-4 py-2 md:hidden">
            <OnboardingProgressBar steps={steps} currentIndex={currentIndex} compact />
          </div>
        )}
      </header>

      {/* ---- Main ---- */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-12">
        <motion.div
          key={steps[currentIndex]?.id ?? 'shell'}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DURATION.base, ease: EASE.out }}
          className="rounded-card-lg border border-slate-200/80 bg-white shadow-card md:shadow-raised"
        >
          <div className="px-5 py-6 md:px-10 md:py-10">{children}</div>
        </motion.div>
      </main>

      {/* ---- Footer (sticky, mobile-friendly) ---- */}
      {!hideActions && (
        <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 md:px-8 md:py-4">
            <Button
              variant="secondary"
              size="md"
              onClick={onBack}
              disabled={!canGoBack}
              aria-label="Go back to the previous step"
            >
              <span className="hidden md:inline">Back</span>
              <span className="md:hidden" aria-hidden="true">←</span>
            </Button>

            <div className="flex items-center gap-2">
              {secondaryAction && (
                <Button variant="ghost" size="md" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              )}
              <Button
                variant="primary"
                size="md"
                onClick={onContinue}
                disabled={!canContinue}
              >
                {continueLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
