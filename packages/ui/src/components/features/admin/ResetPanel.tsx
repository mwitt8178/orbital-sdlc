/**
 * ResetPanel — DANGER ZONE for the emergency reset.
 *
 * The wipe is gated by:
 *   1. The capability admin token (passed in adminToken input)
 *   2. The user typing the exact phrase "I understand this destroys everything"
 *
 * The button only enables when the phrase is exactly correct.
 *
 * After a successful reset, the install_id changes; the UI's onboarding
 * status will detect setup_completed_at: null and redirect to /welcome on
 * the next refresh.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { useAdminToken } from './admin-context.js'

const REQUIRED_PHRASE = 'I understand this destroys everything'

export function ResetPanel() {
  const { token } = useAdminToken()
  const [phrase, setPhrase] = useState('')
  const reset = trpc.admin.reset.danger.useMutation()

  const phraseOk = phrase === REQUIRED_PHRASE

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-slate-900">Reset</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Drops every Orbital schema and re-runs migrations. This is destructive and irreversible.
        </p>
      </header>

      <section
        aria-label="Danger zone"
        className="rounded-lg border-2 border-rose-300 bg-rose-50 p-6 shadow-sm"
      >
        <div className="mb-4 flex items-center gap-2">
          <span aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-rose-600"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          <h3 className="text-sm font-semibold text-rose-900">Danger zone</h3>
        </div>

        <p className="mb-4 text-sm text-rose-900">
          Reset will:
        </p>
        <ul className="mb-5 list-disc space-y-1 pl-6 text-sm text-rose-900">
          <li>DROP audit and public schemas</li>
          <li>Re-run migrations on a clean database</li>
          <li>Write a fresh install.json (new install_id, setup_completed_at: null)</li>
          <li>Force the /welcome wizard on the next page load</li>
        </ul>

        <p className="mb-4 text-sm text-rose-900">
          Type <span className="font-mono font-semibold">{REQUIRED_PHRASE}</span> to enable the
          button:
        </p>

        <Input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={REQUIRED_PHRASE}
          autoComplete="off"
          spellCheck={false}
          hasError={phrase.length > 0 && !phraseOk}
          aria-label="Confirmation phrase"
        />

        <div className="mt-5 flex items-center justify-between">
          <p className="text-xs text-rose-800">
            {phrase.length === 0
              ? 'Phrase required.'
              : phraseOk
                ? 'Phrase matches — the reset button is now armed.'
                : 'Phrase does not match.'}
          </p>
          <Button
            variant="danger"
            disabled={!phraseOk || reset.isPending}
            onClick={() => {
              reset.mutate({
                adminToken: token ?? undefined,
                confirmationPhrase: phrase,
              })
            }}
          >
            {reset.isPending ? 'Resetting…' : 'Reset everything'}
          </Button>
        </div>
      </section>

      {reset.isError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {reset.error.message}
        </div>
      )}

      {reset.data && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-medium">Reset complete</p>
          <p className="mt-1 break-all font-mono text-xs">
            new install_id: {reset.data.newInstallId}
          </p>
          <p className="mt-2">Refresh the page — you will be redirected to the welcome wizard.</p>
        </div>
      )}
    </div>
  )
}
