/**
 * VerifyPanel — chain-walk verifier for capability_id or commit hash.
 *
 * Calls admin.verify.attestation. Renders the four-level chain on success
 * (commit → capability → sub-key → master → install_id) or a clear
 * FAILED reason code on error.
 *
 * Note: commit-signing isn't yet wired in this build — when the input is a
 * commit hash that has no CommitSigned event, we surface the
 * COMMIT_NOT_ATTESTED notice clearly.
 */

import { useState, type FormEvent } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'

interface ChainLevel {
  label: string
  value: string
}

export function VerifyPanel() {
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  const query = trpc.admin.verify.attestation.useQuery(
    { input: submitted ?? '' },
    {
      enabled: submitted !== null && submitted.length > 0,
      retry: false,
    },
  )

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (input.trim().length === 0) return
    setSubmitted(input.trim())
  }

  let chain: ChainLevel[] | null = null
  if (query.data?.ok && query.data.details) {
    chain = [
      { label: 'capability_id', value: query.data.details.capability_id },
      { label: 'persona', value: query.data.details.persona_id },
      { label: 'task', value: query.data.details.task_id },
      { label: 'sprint', value: query.data.details.sprint_id },
      { label: 'sub_key', value: query.data.details.sub_key_id },
      { label: 'master_key', value: query.data.details.master_key_id },
      { label: 'install_id', value: query.data.details.install_id },
    ]
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-slate-900">Verify attestation chain</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Walks the four-level signature chain: commit → capability → sub-key → master → install_id.
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="Verify input"
      >
        <label htmlFor="verify-input" className="mb-1 block text-xs font-medium text-slate-700">
          Capability ID (UUID) or commit hash
        </label>
        <div className="flex gap-2">
          <Input
            id="verify-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. 0193b8c2-…  or  a1b2c3d4"
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" disabled={input.trim().length === 0 || query.isFetching}>
            {query.isFetching ? 'Verifying…' : 'Verify'}
          </Button>
        </div>
      </form>

      {submitted && query.isFetching && !query.data && (
        <p className="text-sm text-slate-500">Verifying chain…</p>
      )}

      {query.data && (
        <section
          aria-label="Verify result"
          className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        >
          <header className="mb-3 flex items-center gap-3">
            {query.data.ok ? (
              <Badge color="emerald">VERIFIED</Badge>
            ) : (
              <Badge color="rose">FAILED</Badge>
            )}
            <span className="font-mono text-xs text-slate-700">{query.data.code}</span>
          </header>

          <p className="text-sm text-slate-700">{query.data.message}</p>

          {query.data.commitNotAttested && (
            <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Commit signing is not yet wired. Verify by capability_id (UUID) instead.
            </p>
          )}

          {chain && (
            <ul className="mt-4 space-y-1 text-xs">
              {chain.map((c, idx) => (
                <li key={c.label} className="flex">
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block w-4 select-none text-slate-300"
                  >
                    {idx === chain!.length - 1 ? '└' : '├'}
                  </span>
                  <span className="w-28 shrink-0 text-slate-500">{c.label}</span>
                  <span className="break-all font-mono text-slate-800">{c.value}</span>
                </li>
              ))}
            </ul>
          )}

          {query.data.ok && query.data.details && (
            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div>
                <p className="text-slate-500">issued_at</p>
                <p className="font-mono text-slate-800">
                  {new Date(query.data.details.issued_at).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-slate-500">expires_at</p>
                <p className="font-mono text-slate-800">
                  {new Date(query.data.details.expires_at).toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </section>
      )}

      {query.isError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {query.error.message}
        </div>
      )}
    </div>
  )
}
