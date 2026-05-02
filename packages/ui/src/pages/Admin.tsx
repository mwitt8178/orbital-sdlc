/**
 * Admin — operations console.
 *
 * Six tabs across the top, each calling a real admin.* tRPC procedure:
 *   /admin               → HealthPanel (default)
 *   /admin/workers       → WorkersPanel
 *   /admin/keys          → KeysPanel
 *   /admin/backups       → BackupsPanel
 *   /admin/verify        → VerifyPanel
 *   /admin/reset         → ResetPanel  (danger zone)
 *
 * Capability gating:
 *   The admin token is held in memory only (TokenProvider, never localStorage).
 *   When unset the layout still renders read-only data; mutations show a banner
 *   prompting the operator to provide a token.
 *
 *   In open dev mode (NODE_ENV=development AND no admin token configured on
 *   the server), mutations succeed without a token. The server logs a warning
 *   on first use.
 */

import { useState, useMemo, type ReactNode } from 'react'
import { NavLink, Routes, Route } from 'react-router-dom'
import clsx from 'clsx'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { HealthPanel } from '../components/features/admin/HealthPanel.js'
import { WorkersPanel } from '../components/features/admin/WorkersPanel.js'
import { KeysPanel } from '../components/features/admin/KeysPanel.js'
import { BackupsPanel } from '../components/features/admin/BackupsPanel.js'
import { VerifyPanel } from '../components/features/admin/VerifyPanel.js'
import { ResetPanel } from '../components/features/admin/ResetPanel.js'
import { HygienePanel } from '../components/features/admin/HygienePanel.js'
import { AdminTokenContext } from '../components/features/admin/admin-context.js'

interface TabSpec {
  to: string
  label: string
  end?: boolean
}

const TABS: TabSpec[] = [
  { to: '/admin', label: 'Health', end: true },
  { to: '/admin/workers', label: 'Workers' },
  { to: '/admin/keys', label: 'Keys' },
  { to: '/admin/backups', label: 'Backups' },
  { to: '/admin/verify', label: 'Verify' },
  { to: '/admin/reset', label: 'Reset' },
  { to: '/admin/hygiene', label: 'Hygiene' },
]

export default function Admin() {
  const [token, setToken] = useState<string | null>(null)
  const tokenCtx = useMemo(() => ({ token, setToken }), [token])

  return (
    <AdminTokenContext.Provider value={tokenCtx}>
      <div className="min-h-screen bg-slate-50">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-[1400px] px-8 py-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                  <span>Orbital</span>
                  <span aria-hidden="true">›</span>
                  <span>Admin</span>
                </div>
                <h1 className="text-2xl font-bold text-slate-900">Operations console</h1>
                <p className="mt-1 text-sm text-slate-500">
                  Health, workers, keys, backups, verify, and reset — every operation that was
                  previously a CLI command, now in one place.
                </p>
              </div>
              <TokenBadge token={token} setToken={setToken} />
            </div>

            <nav aria-label="Admin sections" className="-mb-5 mt-5 flex gap-1 overflow-x-auto">
              {TABS.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    clsx(
                      'rounded-t-md border-b-2 px-4 py-2.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                      isActive
                        ? 'border-brand-600 bg-white font-semibold text-brand-700'
                        : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-8 py-6">
          <Routes>
            <Route index element={<HealthPanel />} />
            <Route path="workers" element={<WorkersPanel />} />
            <Route path="keys" element={<KeysPanel />} />
            <Route path="backups" element={<BackupsPanel />} />
            <Route path="verify" element={<VerifyPanel />} />
            <Route path="reset" element={<ResetPanel />} />
            <Route path="hygiene" element={<HygienePanel />} />
          </Routes>
        </main>
      </div>
    </AdminTokenContext.Provider>
  )
}

interface TokenBadgeProps {
  token: string | null
  setToken: (t: string | null) => void
}

function TokenBadge({ token, setToken }: TokenBadgeProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(token ?? '')
          setOpen(true)
        }}
        className={clsx(
          'rounded-md border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          token
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
        )}
        aria-label={token ? 'Admin token set — click to change' : 'Set admin token'}
      >
        {token ? 'Admin token: set' : 'Set admin token'}
      </button>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setToken(draft.length > 0 ? draft : null)
        setOpen(false)
      }}
      className="flex items-center gap-2"
    >
      <Input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="x-orbital-admin-token"
        autoComplete="off"
        className="w-64"
      />
      <Button type="submit" size="sm">
        Save
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setToken(null)
          setOpen(false)
          setDraft('')
        }}
      >
        Clear
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(false)
          setDraft('')
        }}
      >
        Cancel
      </Button>
    </form>
  )
}

/** Re-export for unit-testing convenience. */
export { TABS as ADMIN_TABS }

/** Render-prop helper for tests that want to render a single panel without setting up the router. */
export function AdminTokenProvider({
  initialToken = null,
  children,
}: {
  initialToken?: string | null
  children: ReactNode
}) {
  const [token, setToken] = useState<string | null>(initialToken)
  const ctx = useMemo(() => ({ token, setToken }), [token])
  return <AdminTokenContext.Provider value={ctx}>{children}</AdminTokenContext.Provider>
}
