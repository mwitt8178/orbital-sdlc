/**
 * SampleDataFlow — Flow D: zero-cost sandbox boot.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #4: sample mode boots without any real creds; UI is
 * fully functional; agents use MockDriver. The mock driver is loaded server-
 * side when ORBITAL_SAMPLE_MODE=on; the UI just shows the bootstrap progress
 * and flips the persistent banner on.
 */

import { useEffect, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'

interface Props {
  sessionId: string
  onComplete: () => void
}

export function SampleDataFlow({ sessionId, onComplete }: Props) {
  const loadSandbox = trpc.onboarding.loadSampleSandbox.useMutation()
  const completeSession = trpc.onboarding.completeSession.useMutation()
  const update = trpc.onboarding.updateSession.useMutation()

  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; bannerText: string; sprintCount: number; channelCount: number; conversionCta: string; projectName: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setStatus({ kind: 'loading' })
      try {
        await update.mutateAsync({ sessionId, step: 'load_sample' })
        const res = await loadSandbox.mutateAsync()
        if (cancelled) return
        setStatus({
          kind: 'loaded',
          bannerText: res.bannerText,
          sprintCount: res.sprintCount,
          channelCount: res.channelCount,
          conversionCta: res.conversionCta,
          projectName: res.projectName,
        })
      } catch (err) {
        if (cancelled) return
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Sample load failed' })
      }
    })()
    return () => {
      cancelled = true
    }
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = async () => {
    try {
      await completeSession.mutateAsync({ sessionId })
    } catch {
      // ignore — already completed
    }
    onComplete()
  }

  return (
    <div data-testid="sample-data-flow">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Loading the sandbox</h1>
        <TimeEstimateBadge estSeconds={15} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Realistic UI, fake data. Agents use a deterministic mock driver — no
        Anthropic spend.
      </p>

      {status.kind === 'idle' && (
        <p className="text-sm text-slate-500">Starting up…</p>
      )}

      {status.kind === 'loading' && (
        <ul className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm" role="status" aria-live="polite">
          <li className="text-slate-700">· Provisioning sample sprint…</li>
          <li className="text-slate-700">· Seeding channels…</li>
          <li className="text-slate-700">· Wiring deterministic agents…</li>
        </ul>
      )}

      {status.kind === 'loaded' && (
        <div className="space-y-4">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm" role="status">
            <p className="font-medium text-emerald-800">✓ Sample sandbox ready</p>
            <ul className="mt-2 space-y-1 text-xs text-emerald-700">
              <li>Sprints: {status.sprintCount}</li>
              <li>Channels: {status.channelCount}</li>
              <li>Project: {status.projectName}</li>
            </ul>
          </div>
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-semibold">Banner:</span> {status.bannerText}
          </p>
          <p className="text-sm text-slate-700">{status.conversionCta}</p>
          <div className="flex gap-3">
            <Button variant="primary" size="lg" onClick={() => void finish()}>
              Open the dashboard
            </Button>
            <Button variant="ghost" size="lg" onClick={() => void finish()}>
              Set up a real project later
            </Button>
          </div>
        </div>
      )}

      {status.kind === 'error' && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{status.message}</p>
      )}
    </div>
  )
}
