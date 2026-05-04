/**
 * /admin/integrations — install-wide tool configuration.
 *
 * This is the SINGLE PLACE where Anthropic, Monday, and GitHub are configured
 * for the whole install. Onboarding no longer captures these — every user-
 * facing wizard reads from these admin-level connections.
 *
 * Reuses the existing <IntegrationsDashboard> card layout (no new design).
 * Each card click drills into a sub-route that exposes the full save/test
 * surface for that provider.
 *
 * [Engineer-Principal · Opus · run-admin-integrations-split]
 */

import { ReactNode, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { trpc } from '../../services/trpc.js'
import { IntegrationsDashboard } from '../../components/features/settings/IntegrationsDashboard.js'
import { GitHubTab } from '../../components/features/settings/GitHubTab.js'

export default function AdminIntegrations() {
  return (
    <Routes>
      <Route element={<AdminIntegrationsShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="anthropic" element={<DetailPage title="Anthropic"><AnthropicCard /></DetailPage>} />
        <Route path="monday" element={<DetailPage title="Monday"><MondayCard /></DetailPage>} />
        <Route path="github" element={<DetailPage title="GitHub"><GithubCard /></DetailPage>} />
        <Route path="*" element={<Navigate to="" replace />} />
      </Route>
    </Routes>
  )
}

import { Outlet } from 'react-router-dom'

function AdminIntegrationsShell() {
  const location = useLocation()
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-[1200px] px-6 py-5">
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <Link to="/" className="hover:text-slate-700">
              Orbital
            </Link>
            <span aria-hidden="true">›</span>
            <Link to="/admin/integrations" className="hover:text-slate-700">
              Admin
            </Link>
            <span aria-hidden="true">›</span>
            <span className="text-slate-700">Integrations</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Tool integrations</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Configure the external services Orbital uses on behalf of every project in this
            install. Each connection persists for all users; individual onboarding wizards no
            longer ask for these credentials.
          </p>
          <nav aria-label="Integrations sub-sections" className="-mb-5 mt-5 flex gap-1">
            {[
              { to: '', label: 'Overview', end: true },
              { to: 'anthropic', label: 'Anthropic' },
              { to: 'monday', label: 'Monday' },
              { to: 'github', label: 'GitHub' },
            ].map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `rounded-t-md border-b-2 px-4 py-2.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    isActive
                      ? 'border-brand-600 bg-white font-semibold text-brand-700'
                      : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main key={location.pathname} className="mx-auto max-w-[1200px] px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function DashboardPage() {
  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Overview</h2>
        <p className="mt-1 text-sm text-slate-600">
          Status of every install-wide connection. Click a card to manage credentials.
        </p>
      </div>
      <IntegrationsDashboard />
    </>
  )
}

function DetailPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      </div>
      <section className="rounded-card-lg border border-slate-200 bg-white p-6 shadow-card">
        {children}
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Anthropic — API key save + test
// ---------------------------------------------------------------------------

function AnthropicCard() {
  const status = trpc.onboarding.status.useQuery()
  const connect = trpc.onboarding.connect.anthropic.useMutation()
  const utils = trpc.useUtils()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const onSave = async () => {
    setError(null)
    setOkMsg(null)
    if (!key.startsWith('sk-ant-')) {
      setError('Anthropic keys begin with sk-ant-.')
      return
    }
    if (key.length < 100) {
      setError(`Anthropic keys are 100+ chars; this is ${key.length}.`)
      return
    }
    try {
      const r = await connect.mutateAsync({ apiKey: key })
      if (!r.ok) {
        setError(r.message ?? 'Anthropic validation failed.')
        return
      }
      setOkMsg('Connected — key validated against api.anthropic.com')
      setEditing(false)
      setKey('')
      await utils.onboarding.status.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anthropic connect failed.')
    }
  }

  const connected = status.data?.hasAnthropicToken ?? false

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Anthropic API key</h3>
        <p className="mt-1 text-xs text-slate-500">
          Stored encrypted server-side. Used by every persona's reasoning + drafting across all
          projects in this install.
        </p>
      </div>
      <StatusPillRow connected={connected} connectedLabel="Key on file" emptyLabel="No key on file" />
      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {connected ? 'Replace key' : 'Add key'}
        </button>
      ) : (
        <div className="space-y-3">
          <input
            type="password"
            placeholder="sk-ant-..."
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-label="Anthropic API key"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={connect.isPending || key.length < 100}
              className="inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connect.isPending ? 'Validating…' : 'Save & test connection'}
            </button>
            <button
              type="button"
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
              onClick={() => {
                setEditing(false)
                setKey('')
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {okMsg && (
        <p className="text-xs font-medium text-emerald-700" role="status">
          {okMsg}
        </p>
      )}
      {error && (
        <p className="text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monday — API token + optional board id
// ---------------------------------------------------------------------------

function MondayCard() {
  const status = trpc.onboarding.status.useQuery()
  const connect = trpc.onboarding.connect.monday.useMutation()
  const utils = trpc.useUtils()
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [boardId, setBoardId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const onSave = async () => {
    setError(null)
    setOkMsg(null)
    if (token.length < 32) {
      setError(`Monday tokens are 32+ chars; this is ${token.length}.`)
      return
    }
    try {
      const r = await connect.mutateAsync({
        apiToken: token,
        ...(boardId ? { boardId } : {}),
      })
      if (!r.ok) {
        setError(r.message ?? 'Monday validation failed.')
        return
      }
      setOkMsg(`Connected${r.accountName ? ` — account ${r.accountName}` : ''}`)
      setEditing(false)
      setToken('')
      setBoardId('')
      await utils.onboarding.status.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Monday connect failed.')
    }
  }

  const connected = status.data?.hasMondayToken ?? false

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Monday API token</h3>
        <p className="mt-1 text-xs text-slate-500">
          Optional — when configured, projects can mirror their backlog onto a Monday board.
        </p>
      </div>
      <StatusPillRow connected={connected} connectedLabel="Token on file" emptyLabel="No token on file" />
      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {connected ? 'Replace token' : 'Add token'}
        </button>
      ) : (
        <div className="space-y-3">
          <input
            type="password"
            placeholder="Monday API token"
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-label="Monday API token"
          />
          <input
            type="text"
            placeholder="Board ID (optional)"
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-label="Monday board id"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={connect.isPending || token.length < 32}
              className="inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {connect.isPending ? 'Validating…' : 'Save & test connection'}
            </button>
            <button
              type="button"
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
              onClick={() => {
                setEditing(false)
                setToken('')
                setBoardId('')
                setError(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {okMsg && (
        <p className="text-xs font-medium text-emerald-700" role="status">
          {okMsg}
        </p>
      )}
      {error && (
        <p className="text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub — PAT (immediate) + GitHub App (recommended)
// ---------------------------------------------------------------------------

function GithubCard() {
  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">GitHub connection</h3>
        <p className="mt-1 text-xs text-slate-500">
          Two ways to connect. Personal Access Token unblocks you immediately; the GitHub App is
          the recommended long-term path (per-org install, no token rotation, granular scopes).
        </p>
      </div>

      <section>
        <h4 className="text-sm font-semibold text-slate-900">Option 1 — Personal Access Token</h4>
        <p className="mt-1 mb-4 text-xs text-slate-500">
          Use this to ship today. Reuses the existing PAT panel from Settings.
        </p>
        <GitHubTab />
      </section>

      <section className="border-t border-slate-200 pt-6">
        <h4 className="text-sm font-semibold text-slate-900">
          Option 2 — GitHub App (recommended)
        </h4>
        <p className="mt-1 mb-4 text-xs text-slate-500">
          Install the Orbital GitHub App on your org. The App's already shipped at{' '}
          <Link
            to="/settings/integrations/github"
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            /settings/integrations/github
          </Link>
          . It supersedes the PAT once installed.
        </p>
        <Link
          to="/settings/integrations/github"
          className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Install GitHub App →
        </Link>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StatusPillRow({
  connected,
  connectedLabel,
  emptyLabel,
}: {
  connected: boolean
  connectedLabel: string
  emptyLabel: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
        connected
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-slate-200 bg-slate-100 text-slate-600'
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`}
      />
      {connected ? connectedLabel : emptyLabel}
    </span>
  )
}
