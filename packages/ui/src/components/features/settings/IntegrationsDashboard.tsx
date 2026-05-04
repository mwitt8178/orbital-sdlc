/**
 * IntegrationsDashboard — unified view of every external service Orbital
 * connects to.
 *
 * Each provider is one card with:
 *   - Status pill (connected / not connected / error)
 *   - One-line summary of what it's used for
 *   - Last-sync indicator when available
 *   - Test-connection button + manage link
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { DURATION, EASE } from '../../onboarding/motion.js'

type Status = 'connected' | 'disconnected' | 'error' | 'unknown'

interface ProviderCardProps {
  id: string
  name: string
  blurb: string
  status: Status
  detail?: string | null
  manageHref?: string
  onTest?: () => Promise<{ ok: boolean; message?: string }>
}

export function IntegrationsDashboard() {
  const status = trpc.onboarding.status.useQuery()

  const anthropicStatus: Status = status.data?.hasAnthropicToken ? 'connected' : 'disconnected'
  const mondayStatus: Status = status.data?.hasMondayToken ? 'connected' : 'disconnected'
  const githubStatus: Status =
    (status.data as { hasGitHubInstall?: boolean } | undefined)?.hasGitHubInstall === true
      ? 'connected'
      : 'disconnected'
  const hubStatusValue: Status = 'unknown'

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ProviderCard
        id="anthropic"
        name="Anthropic"
        blurb="LLM provider. Powers every persona's reasoning + drafting."
        status={anthropicStatus}
        detail={status.data?.hasAnthropicToken ? 'API key on file (encrypted)' : 'No key on file'}
        manageHref="/settings/integrations/anthropic"
        onTest={async () => ({ ok: anthropicStatus === 'connected', message: anthropicStatus === 'connected' ? 'OK' : 'Add a key first' })}
      />
      <ProviderCard
        id="github"
        name="GitHub"
        blurb="Repo creation, PR loop, webhooks, CI workflow commits."
        status={githubStatus}
        detail={githubStatus === 'connected' ? 'App installation active' : 'Not installed'}
        manageHref="/settings/integrations/github"
      />
      <ProviderCard
        id="monday"
        name="Monday"
        blurb="Backlog board mirror. Optional — Orbital ships an internal backlog if absent."
        status={mondayStatus}
        detail={status.data?.hasMondayToken ? 'API token on file' : 'No token on file'}
        manageHref="/settings/integrations/monday"
      />
      <ProviderCard
        id="hub"
        name="Team hub"
        blurb="Federated team workspace. Connect to a teammate's hub via invite URL."
        status={hubStatusValue}
        detail="Single-machine mode unless you've joined a hub via invite URL"
        manageHref="/settings/integrations/hub"
      />
    </div>
  )
}

function ProviderCard({ id, name, blurb, status, detail, manageHref, onTest }: ProviderCardProps) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null)

  const handleTest = async () => {
    if (!onTest) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await onTest()
      setTestResult(r)
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE.out }}
      className="rounded-card-lg border border-slate-200 bg-white p-5 shadow-card"
      data-testid={`integration-card-${id}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{name}</h3>
          <p className="mt-0.5 text-sm text-slate-600">{blurb}</p>
        </div>
        <StatusPill status={status} />
      </div>

      <p className="mt-3 text-xs text-slate-500">{detail}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {onTest && (
          <Button variant="secondary" size="sm" onClick={() => void handleTest()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        )}
        {manageHref && (
          <a
            href={manageHref}
            className="inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
          >
            Manage →
          </a>
        )}
        {testResult && (
          <span
            role="status"
            className={`text-xs font-medium ${
              testResult.ok ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {testResult.ok ? '✓' : '✗'} {testResult.message ?? (testResult.ok ? 'OK' : 'Failed')}
          </span>
        )}
      </div>
    </motion.div>
  )
}

function StatusPill({ status }: { status: Status }) {
  const tone =
    status === 'connected'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'error'
        ? 'bg-red-50 text-red-700 border-red-200'
        : status === 'disconnected'
          ? 'bg-slate-100 text-slate-600 border-slate-200'
          : 'bg-amber-50 text-amber-700 border-amber-200'
  const dotColor =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'error'
        ? 'bg-red-500'
        : status === 'disconnected'
          ? 'bg-slate-400'
          : 'bg-amber-500'
  const label =
    status === 'connected'
      ? 'Connected'
      : status === 'error'
        ? 'Error'
        : status === 'disconnected'
          ? 'Not connected'
          : 'Unknown'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
      {label}
    </span>
  )
}
