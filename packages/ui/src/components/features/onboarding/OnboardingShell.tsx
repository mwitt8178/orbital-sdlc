/**
 * OnboardingShell — wraps each wizard step with logo, progress bar, content,
 * and Back/Continue actions.
 */

import { ReactNode } from 'react'
import { Button } from '../../ui/Button.js'
import { OnboardingProgressBar } from './OnboardingProgressBar.js'

export interface ShellStep {
  id: string
  label: string
}

interface Props {
  steps: ShellStep[]
  currentIndex: number
  /** When true, the Back button is disabled. */
  canGoBack?: boolean
  /** When false, the Continue button is disabled. */
  canContinue?: boolean
  continueLabel?: string
  onBack?: () => void
  onContinue?: () => void
  /** Hides the bottom action bar entirely (e.g. on the last step where the
   *  step itself owns the submit button). */
  hideActions?: boolean
  children: ReactNode
}

export function OnboardingShell({
  steps,
  currentIndex,
  canGoBack = true,
  canContinue = true,
  continueLabel = 'Continue',
  onBack,
  onContinue,
  hideActions = false,
  children,
}: Props) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2a10 10 0 0 1 8.66 5" />
                <path d="M22 12a10 10 0 0 1-5 8.66" />
                <path d="M12 22a10 10 0 0 1-8.66-5" />
                <path d="M2 12a10 10 0 0 1 5-8.66" />
              </svg>
            </div>
            <div className="font-semibold text-slate-900">Orbital</div>
          </div>
          <OnboardingProgressBar steps={steps} currentIndex={currentIndex} />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-card">
          {children}
        </div>

        {!hideActions && (
          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="secondary"
              size="lg"
              onClick={onBack}
              disabled={!canGoBack}
            >
              Back
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={onContinue}
              disabled={!canContinue}
              className="bg-brand-600 hover:bg-brand-700 active:bg-brand-800"
            >
              {continueLabel}
            </Button>
          </div>
        )}
      </main>
    </div>
  )
}
