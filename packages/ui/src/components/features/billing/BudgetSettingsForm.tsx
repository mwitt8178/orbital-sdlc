/**
 * BudgetSettingsForm — monthly cap, hard-stop toggle, digest emails.
 *
 * Each control persists on blur (cap, emails) or on change (hard-stop). All
 * mutations call cost.updateBudget which returns the new summary for cache
 * sync.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

import { useEffect, useState } from 'react'
import { trpc } from '../../../services/trpc.js'

interface Props {
  projectId: string
  monthlyCapUsd: number | null
  hardStop: boolean
  digestEmails: string[]
  onUpdated: () => void
}

export function BudgetSettingsForm({
  projectId,
  monthlyCapUsd,
  hardStop,
  digestEmails,
  onUpdated,
}: Props) {
  const updateMutation = trpc.billing.updateBudget.useMutation({
    onSuccess: () => onUpdated(),
  })

  const [cap, setCap] = useState<string>(monthlyCapUsd != null ? monthlyCapUsd.toFixed(2) : '')
  const [emailsText, setEmailsText] = useState<string>(digestEmails.join(', '))
  const [savedFlash, setSavedFlash] = useState<'cap' | 'emails' | 'hard' | null>(null)

  // Re-sync when server values change.
  useEffect(() => {
    setCap(monthlyCapUsd != null ? monthlyCapUsd.toFixed(2) : '')
  }, [monthlyCapUsd])
  useEffect(() => {
    setEmailsText(digestEmails.join(', '))
  }, [digestEmails])

  const flashSaved = (key: 'cap' | 'emails' | 'hard') => {
    setSavedFlash(key)
    window.setTimeout(() => setSavedFlash((cur) => (cur === key ? null : cur)), 1500)
  }

  const persistCap = () => {
    const trimmed = cap.trim()
    let cents: number | null = null
    if (trimmed === '') {
      cents = null
    } else {
      const usd = Number.parseFloat(trimmed)
      if (Number.isNaN(usd) || usd < 0) return
      cents = Math.round(usd * 100)
    }
    if (cents === Math.round((monthlyCapUsd ?? 0) * 100) && monthlyCapUsd != null && trimmed !== '') {
      return // unchanged
    }
    if (cents == null && monthlyCapUsd == null) return
    updateMutation.mutate(
      { projectId, patch: { monthlyCapCents: cents } },
      { onSuccess: () => flashSaved('cap') },
    )
  }

  const persistEmails = () => {
    const next = emailsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    // Cheap email regex; the server zod-validates strictly.
    const allValid = next.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    if (!allValid) return
    if (next.length === digestEmails.length && next.every((e, i) => e === digestEmails[i])) return
    updateMutation.mutate(
      { projectId, patch: { digestEmails: next } },
      { onSuccess: () => flashSaved('emails') },
    )
  }

  const persistHardStop = (next: boolean) => {
    updateMutation.mutate(
      { projectId, patch: { hardStop: next } },
      { onSuccess: () => flashSaved('hard') },
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="billing-monthly-cap" className="mb-1 block text-sm font-medium text-slate-700">
          Monthly cap (USD)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">$</span>
          <input
            id="billing-monthly-cap"
            type="number"
            min="0"
            step="0.01"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={persistCap}
            placeholder="No cap"
            className="w-40 rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-describedby="billing-monthly-cap-help"
          />
          {savedFlash === 'cap' && (
            <span className="text-xs text-emerald-600">Saved</span>
          )}
        </div>
        <p id="billing-monthly-cap-help" className="mt-1 text-xs text-slate-400">
          Leave blank for no monthly cap. Spend is summed across all worker, planning, and review calls.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-700">Hard stop on cap</p>
            <p className="text-xs text-slate-400">
              When on, agents <strong>pause</strong> the moment any cap is reached. When off, the cap only emits a warning.
            </p>
          </div>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={hardStop}
              onChange={(e) => persistHardStop(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm font-medium text-slate-700">{hardStop ? 'Pause' : 'Warn'}</span>
          </label>
        </div>
        {savedFlash === 'hard' && <p className="mt-1 text-xs text-emerald-600">Saved</p>}
      </div>

      <div>
        <label htmlFor="billing-digest-emails" className="mb-1 block text-sm font-medium text-slate-700">
          Digest emails
        </label>
        <input
          id="billing-digest-emails"
          type="text"
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
          onBlur={persistEmails}
          placeholder="email@example.com, finance@example.com"
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="mt-1 text-xs text-slate-400">
          Comma-separated. Each address receives a daily and weekly cost summary. Leave blank to opt out.
        </p>
        {savedFlash === 'emails' && <p className="mt-1 text-xs text-emerald-600">Saved</p>}
      </div>

      {updateMutation.isError && (
        <p className="text-xs text-red-600">{updateMutation.error.message}</p>
      )}
    </div>
  )
}
