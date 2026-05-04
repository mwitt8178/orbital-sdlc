/**
 * ToolingStep — per-project SCM + ticket provider pickers.
 *
 * The previous round captured Anthropic / Monday / GitHub credentials inside
 * the onboarding wizard. Those are now admin-level concerns at
 * /admin/integrations. Each project still gets to choose WHICH provider to
 * use; this step captures that choice.
 *
 * Defaults: scm=internal (Orbital-managed CodeCommit), ticket=internal
 * (Orbital backlog). Both fall back to defaults whenever the admin has not
 * connected the upstream provider.
 *
 * [Engineer-Principal · Opus · run-admin-integrations-split]
 */

import { useEffect } from 'react'
import { Link } from 'react-router-dom'

export type ScmProvider = 'internal' | 'github' | 'codecommit'
export type TicketProvider = 'internal' | 'monday'

export interface ToolingChoice {
  scmProvider: ScmProvider
  ticketProvider: TicketProvider
}

interface Props {
  initial: ToolingChoice
  hasGithubAdmin: boolean
  hasMondayAdmin: boolean
  onChange: (next: ToolingChoice, valid: boolean) => void
}

export function ToolingStep({ initial, hasGithubAdmin, hasMondayAdmin, onChange }: Props) {
  // Tell the parent the picker is always "valid" — we always have a default.
  useEffect(() => {
    onChange(initial, true)
  }, [initial, onChange])

  const setScm = (scm: ScmProvider) => onChange({ ...initial, scmProvider: scm }, true)
  const setTicket = (t: TicketProvider) => onChange({ ...initial, ticketProvider: t }, true)

  return (
    <div data-testid="tooling-step" className="space-y-8">
      <div>
        <h1 className="text-display-md text-slate-900">Pick your tools for this project</h1>
        <p className="mt-2 text-sm text-slate-600">
          Orbital ships sensible defaults that work without any external accounts. If your admin has
          connected GitHub or Monday at{' '}
          <Link
            to="/admin/integrations"
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            /admin/integrations
          </Link>
          , you can pick those instead.
        </p>
      </div>

      {/* SCM picker */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Source control
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <ProviderRadio
            id="scm-internal"
            name="scm-provider"
            value="internal"
            checked={initial.scmProvider === 'internal'}
            title="Orbital managed (default)"
            blurb="AWS CodeCommit repo provisioned by Orbital. Zero setup, no extra accounts."
            onSelect={() => setScm('internal')}
            disabled={false}
          />
          <ProviderRadio
            id="scm-github"
            name="scm-provider"
            value="github"
            checked={initial.scmProvider === 'github'}
            title="GitHub"
            blurb={
              hasGithubAdmin
                ? 'Use the GitHub connection your admin configured at /admin/integrations.'
                : 'GitHub not configured by your admin yet.'
            }
            onSelect={() => setScm('github')}
            disabled={!hasGithubAdmin}
            adminLink={!hasGithubAdmin ? '/admin/integrations' : null}
          />
          <ProviderRadio
            id="scm-codecommit"
            name="scm-provider"
            value="codecommit"
            checked={initial.scmProvider === 'codecommit'}
            title="Bring your own CodeCommit"
            blurb="Advanced — requires AWS CodeCommit access in your account. Coming soon."
            onSelect={() => setScm('codecommit')}
            disabled={true}
            tooltip="Advanced provider — wiring up post-v1."
          />
        </div>
      </section>

      {/* Ticket picker */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Ticket tracking
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <ProviderRadio
            id="ticket-internal"
            name="ticket-provider"
            value="internal"
            checked={initial.ticketProvider === 'internal'}
            title="Orbital backlog (default)"
            blurb="Built-in epics + stories + sprints. No third-party account required."
            onSelect={() => setTicket('internal')}
            disabled={false}
          />
          <ProviderRadio
            id="ticket-monday"
            name="ticket-provider"
            value="monday"
            checked={initial.ticketProvider === 'monday'}
            title="Monday.com"
            blurb={
              hasMondayAdmin
                ? 'Use the Monday connection your admin configured.'
                : 'Monday not configured by your admin yet.'
            }
            onSelect={() => setTicket('monday')}
            disabled={!hasMondayAdmin}
            adminLink={!hasMondayAdmin ? '/admin/integrations' : null}
          />
        </div>
      </section>
    </div>
  )
}

interface RadioProps {
  id: string
  name: string
  value: string
  checked: boolean
  title: string
  blurb: string
  onSelect: () => void
  disabled: boolean
  tooltip?: string
  adminLink?: string | null
}

function ProviderRadio({
  id,
  name,
  value,
  checked,
  title,
  blurb,
  onSelect,
  disabled,
  tooltip,
  adminLink,
}: RadioProps) {
  return (
    <label
      htmlFor={id}
      className={`relative flex cursor-pointer flex-col gap-2 rounded-card-lg border p-4 shadow-card transition focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-500 ${
        disabled
          ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70'
          : checked
            ? 'border-brand-300 bg-brand-50'
            : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
      title={disabled && tooltip ? tooltip : undefined}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      <div className="flex items-start justify-between">
        <span className="text-sm font-semibold text-slate-900">{title}</span>
        <span
          aria-hidden="true"
          className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border ${
            checked && !disabled
              ? 'border-brand-600 bg-brand-600 text-white'
              : 'border-slate-300 bg-white'
          }`}
        >
          {checked && !disabled && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </div>
      <p className="text-xs text-slate-600">{blurb}</p>
      {disabled && adminLink && (
        <Link
          to={adminLink}
          className="text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Configure at /admin/integrations →
        </Link>
      )}
    </label>
  )
}
