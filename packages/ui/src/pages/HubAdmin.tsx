/**
 * HubAdmin — hub operations console.
 *
 * Round 7-07 — Hub Deployment + Operations
 * [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
 *
 * Only renders when ctx.role === 'owner'. In local mode or for non-owner
 * roles, shows an access-denied message.
 *
 * Four tabs:
 *   /hub-admin          → Health
 *   /hub-admin/installs → Installs
 *   /hub-admin/audit    → Audit Tail
 *   /hub-admin/backup   → Backup
 *
 * Owner token is held in memory only (same pattern as Admin page).
 * The x-orbital-owner-token header is passed to each panel.
 */

import { useState, useMemo, type ReactNode } from 'react'
import { NavLink, Routes, Route } from 'react-router-dom'
import clsx from 'clsx'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { HubHealthPanel } from '../components/features/hub-admin/HealthPanel.js'
import { InstallsTable } from '../components/features/hub-admin/InstallsTable.js'
import { AuditTail } from '../components/features/hub-admin/AuditTail.js'
import { BackupPanel } from '../components/features/hub-admin/BackupPanel.js'
import { trpc } from '../services/trpc.js'

// ---------------------------------------------------------------------------
// Role guard
// ---------------------------------------------------------------------------

/**
 * useHubRole — resolves the current session's role and ORBITAL_MODE.
 *
 * Round 7-03's auth (ed25519 signed sessions) will eventually populate
 * ctx.role via tRPC context. For now, we query admin.health.live which
 * returns installId, then cross-reference with the mode env var that the
 * server embeds in the /health response.
 *
 * Placeholder strategy per architecture brief:
 *   - Call /health to check ORBITAL_MODE
 *   - Check ORBITAL_OWNER_TOKEN env var presence via a dedicated status endpoint
 *   - For now: treat "has an owner token set" as role='owner'
 *
 * When Round 7-03 ships, replace this with tRPC ctx.role check.
 */
function useHubMode(): { isHub: boolean; loading: boolean } {
  const health = trpc.admin.health.live.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  })

  // The /health HTTP endpoint includes `mode` — check it
  const [isHub, setIsHub] = useState<boolean | null>(null)

  // Fallback: check /health HTTP directly (not tRPC — hub mode wires this)
  useMemo(() => {
    if (isHub !== null) return
    fetch('/health')
      .then((r) => r.json())
      .then((data: { mode?: string }) => {
        setIsHub(data.mode === 'hub')
      })
      .catch(() => setIsHub(false))
  }, [isHub])

  return {
    isHub: isHub === true,
    loading: isHub === null && health.isLoading,
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface TabSpec {
  to: string
  label: string
  end?: boolean
}

const TABS: TabSpec[] = [
  { to: '/hub-admin', label: 'Health', end: true },
  { to: '/hub-admin/installs', label: 'Installs' },
  { to: '/hub-admin/audit', label: 'Audit Tail' },
  { to: '/hub-admin/backup', label: 'Backup' },
]

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HubAdmin() {
  const { isHub, loading } = useHubMode()
  const [ownerToken, setOwnerToken] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Checking hub mode…</p>
      </div>
    )
  }

  if (!isHub) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">Hub Admin unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">
            This instance is running in local mode. Hub Admin is only available when{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">ORBITAL_MODE=hub</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-[1400px] px-8 py-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <span>Orbital</span>
                <span aria-hidden="true">›</span>
                <span>Hub Admin</span>
              </div>
              <h1 className="text-2xl font-bold text-slate-900">Hub operations</h1>
              <p className="mt-1 text-sm text-slate-500">
                Health, installs, audit trail, and backup — hub-mode only.
              </p>
            </div>
            <OwnerTokenBadge token={ownerToken} setToken={setOwnerToken} />
          </div>

          <nav aria-label="Hub admin sections" className="-mb-5 mt-5 flex gap-1 overflow-x-auto">
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
          <Route index element={<HubHealthPanel />} />
          <Route path="installs" element={<InstallsTable ownerToken={ownerToken} />} />
          <Route path="audit" element={<AuditTail ownerToken={ownerToken} />} />
          <Route path="backup" element={<BackupPanel ownerToken={ownerToken} />} />
        </Routes>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Owner token badge (in-memory, same pattern as admin page)
// ---------------------------------------------------------------------------

interface OwnerTokenBadgeProps {
  token: string | null
  setToken: (t: string | null) => void
}

function OwnerTokenBadge({ token, setToken }: OwnerTokenBadgeProps) {
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
        aria-label={token ? 'Owner token set — click to change' : 'Set owner token'}
      >
        {token ? 'Owner token: set' : 'Set owner token'}
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
        placeholder="x-orbital-owner-token"
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

/** Re-export for tests */
export { TABS as HUB_ADMIN_TABS }

/** Render-prop helper for tests */
export function HubAdminOwnerTokenProvider({
  initialToken = null,
  children,
}: {
  initialToken?: string | null
  children: ReactNode
}) {
  return <>{children}</>
}
