/**
 * FirstSprintStep — confirm or skip the first-sprint draft for the new-project
 * flow.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * This step is intentionally light — the heavy lifting (PM agent drafting
 * tickets, cost forecast) happens once a sprint launch is requested. Here we
 * just capture intent.
 */

import { useState } from 'react'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'
import { SkipWithRecoveryHint } from '../../ui/SkipWithRecoveryHint.js'

interface Props {
  onChoice: (choice: 'launch' | 'edit' | 'skip') => void
}

export function FirstSprintStep({ onChoice }: Props) {
  const [pending, setPending] = useState<null | 'launch' | 'edit' | 'skip'>(null)

  const click = (c: 'launch' | 'edit' | 'skip') => {
    setPending(c)
    onChoice(c)
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">First sprint</h1>
        <TimeEstimateBadge estSeconds={60} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Orbital can draft a 4-6 ticket sprint from your vision and Memory entries.
      </p>

      <div className="space-y-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">
            Sprint 1 forecast (estimated): $8.50 / $20 hard cap
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Tokens are hard-capped at $20/sprint by default; the budget enforcer
            kills any worker that would breach the cap.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            onClick={() => click('launch')}
            disabled={pending !== null}
          >
            Launch sprint 1
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => click('edit')}
            disabled={pending !== null}
          >
            Edit before launch
          </Button>
        </div>

        <SkipWithRecoveryHint
          recoveryPath="Backlog → Plan a sprint"
          onSkip={() => click('skip')}
        />
      </div>
    </div>
  )
}
