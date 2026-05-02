/**
 * TokensStep — Step 3 of the onboarding wizard (live mode only).
 *
 * Two stacked sections — Anthropic (required) and Monday (optional). Each
 * has Validate-and-save that hits the orchestrator's onboarding.connect.*
 * mutation, which makes a real API call before storing the token.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'

type TokenStatus =
  | { kind: 'idle' }
  | { kind: 'validating' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

interface Props {
  onAnthropicSaved: () => void
  onMondaySaved: () => void
  hasAnthropicSaved: boolean
  hasMondaySaved: boolean
  /** When true, the user explicitly chose to skip Monday. */
  mondaySkipped: boolean
  onSkipMonday: (skip: boolean) => void
}

export function TokensStep({
  onAnthropicSaved,
  onMondaySaved,
  hasAnthropicSaved,
  hasMondaySaved,
  mondaySkipped,
  onSkipMonday,
}: Props) {
  const [anthropicKey, setAnthropicKey] = useState('')
  const [mondayToken, setMondayToken] = useState('')
  const [mondayBoardId, setMondayBoardId] = useState('')

  const [anthropicStatus, setAnthropicStatus] = useState<TokenStatus>({ kind: 'idle' })
  const [mondayStatus, setMondayStatus] = useState<TokenStatus>({ kind: 'idle' })

  const anthropicMutation = trpc.onboarding.connect.anthropic.useMutation()
  const mondayMutation = trpc.onboarding.connect.monday.useMutation()

  const validateAnthropic = async () => {
    setAnthropicStatus({ kind: 'validating' })
    try {
      const result = await anthropicMutation.mutateAsync({ apiKey: anthropicKey })
      if (result.ok) {
        const balance =
          typeof result.balanceCents === 'number'
            ? ` Balance: $${(result.balanceCents / 100).toFixed(2)}`
            : ''
        setAnthropicStatus({ kind: 'ok', message: `Connected.${balance}` })
        onAnthropicSaved()
      } else {
        setAnthropicStatus({ kind: 'error', message: result.message ?? 'Validation failed' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Validation failed'
      setAnthropicStatus({ kind: 'error', message: msg })
    }
  }

  const validateMonday = async () => {
    setMondayStatus({ kind: 'validating' })
    try {
      const result = await mondayMutation.mutateAsync({
        apiToken: mondayToken,
        boardId: mondayBoardId || undefined,
      })
      if (result.ok) {
        const name = result.accountName ? ` (${result.accountName})` : ''
        setMondayStatus({ kind: 'ok', message: `Connected.${name}` })
        onMondaySaved()
      } else {
        setMondayStatus({ kind: 'error', message: result.message ?? 'Validation failed' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Validation failed'
      setMondayStatus({ kind: 'error', message: msg })
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-slate-900">Connect your accounts</h1>
      <p className="mb-8 text-sm text-slate-500">
        Anthropic powers the agents. Monday is optional — you can connect later.
      </p>

      <section className="mb-6 rounded-lg border border-slate-200 p-5">
        <header className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Anthropic API key</h2>
            <p className="text-xs text-slate-500">
              We&rsquo;ll send a 1-token request to verify the key (~$0.0001 charged).
            </p>
          </div>
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Get a key &rarr;
          </a>
        </header>

        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="sk-ant-..."
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            disabled={hasAnthropicSaved || anthropicStatus.kind === 'validating'}
            aria-label="Anthropic API key"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="primary"
            onClick={validateAnthropic}
            disabled={
              !anthropicKey ||
              hasAnthropicSaved ||
              anthropicStatus.kind === 'validating'
            }
            className="bg-brand-600 hover:bg-brand-700"
          >
            {anthropicStatus.kind === 'validating' ? 'Validating…' : 'Validate & save'}
          </Button>
        </div>

        <StatusLine status={anthropicStatus} hasSaved={hasAnthropicSaved} />
      </section>

      <section className="rounded-lg border border-slate-200 p-5">
        <header className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Monday.com token
              <span className="ml-2 text-xs font-normal text-slate-500">(optional)</span>
            </h2>
            <p className="text-xs text-slate-500">
              We&rsquo;ll call <code className="rounded bg-slate-100 px-1">me &#123; name &#125;</code> to
              verify.
            </p>
          </div>
          <a
            href="https://developer.monday.com/api-reference/docs/authentication"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Where to find it &rarr;
          </a>
        </header>

        <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={mondaySkipped}
            onChange={(e) => onSkipMonday(e.target.checked)}
            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Skip Monday for now
        </label>

        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="eyJ..."
            value={mondayToken}
            onChange={(e) => setMondayToken(e.target.value)}
            disabled={
              mondaySkipped || hasMondaySaved || mondayStatus.kind === 'validating'
            }
            aria-label="Monday API token"
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            type="text"
            placeholder="Board ID (optional)"
            value={mondayBoardId}
            onChange={(e) => setMondayBoardId(e.target.value)}
            disabled={
              mondaySkipped || hasMondaySaved || mondayStatus.kind === 'validating'
            }
            aria-label="Monday board ID"
            className="max-w-[180px]"
          />
          <Button
            variant="primary"
            onClick={validateMonday}
            disabled={
              !mondayToken ||
              mondaySkipped ||
              hasMondaySaved ||
              mondayStatus.kind === 'validating'
            }
            className="bg-brand-600 hover:bg-brand-700"
          >
            {mondayStatus.kind === 'validating' ? 'Validating…' : 'Validate & save'}
          </Button>
        </div>

        <StatusLine status={mondayStatus} hasSaved={hasMondaySaved} />
      </section>
    </div>
  )
}

function StatusLine({
  status,
  hasSaved,
}: {
  status: TokenStatus
  hasSaved: boolean
}) {
  if (hasSaved && status.kind === 'idle') {
    return (
      <p className="mt-2 text-xs font-medium text-emerald-600" role="status">
        ✓ Already connected.
      </p>
    )
  }
  if (status.kind === 'ok') {
    return (
      <p className="mt-2 text-xs font-medium text-emerald-600" role="status">
        ✓ {status.message}
      </p>
    )
  }
  if (status.kind === 'error') {
    return (
      <p className="mt-2 text-xs font-medium text-rose-600" role="alert">
        ✗ {status.message}
      </p>
    )
  }
  return null
}
