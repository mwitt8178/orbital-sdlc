import { NavLink, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { ReactNode, useEffect, useState } from 'react'
import { PulseDot } from '../ui/PulseDot.js'

interface NavItemProps {
  to: string
  icon: ReactNode
  label: string
  badge?: ReactNode
}

function NavItem({ to, icon, label, badge }: NavItemProps) {
  const location = useLocation()
  // Dashboard is the index route — active only on exact match
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)

  return (
    <NavLink
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-700',
      )}
    >
      <span
        className={clsx('flex-shrink-0', isActive ? 'text-brand-500' : 'text-slate-400')}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {badge}
    </NavLink>
  )
}

interface DisabledNavItemProps {
  icon: ReactNode
  label: string
}

function DisabledNavItem({ icon, label }: DisabledNavItemProps) {
  return (
    <button
      disabled
      className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-slate-400 opacity-60"
      aria-disabled="true"
    >
      <span className="flex-shrink-0 text-slate-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
      {children}
    </div>
  )
}

/** Live Telemetry panel at the bottom of the sidebar — shows placeholder data until real data flows. */
function LiveTelemetryPanel() {
  return (
    <div className="border-t border-slate-100 px-3 py-3">
      <div className="pb-2 pl-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        Live Telemetry
      </div>
      <div className="space-y-2 pl-1">
        <div className="flex justify-between text-xs">
          <span className="text-slate-500">Agents in flight</span>
          <span className="font-mono font-medium text-slate-700">0</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-slate-500">Sprint cost</span>
          <span className="font-mono font-medium text-slate-700">—</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-slate-500">Budget</span>
          <span className="font-mono font-medium text-slate-700">—</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
          {/* No data yet — empty bar */}
          <div className="h-full w-0 rounded-full bg-emerald-500" />
        </div>
      </div>
    </div>
  )
}

/**
 * useIsHubOwner — lightweight hub mode + role detection.
 *
 * Round 7-07: checks /health for ORBITAL_MODE=hub.
 * Round 7-03 (auth) will replace this with a proper session role check.
 * For now: show Hub Admin link when mode=hub (every hub user can reach the
 * page; the page itself enforces the owner token gate).
 */
function useIsHubOwner(): boolean {
  const [isHub, setIsHub] = useState(false)

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((data: { mode?: string }) => {
        setIsHub(data.mode === 'hub')
      })
      .catch(() => setIsHub(false))
  }, [])

  return isHub
}

export function SideNav() {
  const isHubOwner = useIsHubOwner()

  return (
    <nav
      className="scrollbar-thin flex w-56 flex-shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white"
      aria-label="Primary navigation"
    >
      <div className="flex-1 space-y-0.5 p-3">
        <SectionLabel>Workflow</SectionLabel>

        <NavItem
          to="/"
          label="Sprint Dashboard"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" />
              <rect x="14" y="3" width="7" height="5" />
              <rect x="14" y="12" width="7" height="9" />
              <rect x="3" y="16" width="7" height="5" />
            </svg>
          }
        />

        {/* Round 6 #10: Agent Inspector — [Engineer-Sr · Sonnet · run-round6-10-inspection] */}
        <NavItem
          to="/agents"
          label="Agents"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          }
        />

        <NavItem
          to="/backlog"
          label="Backlog"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 9h6v6H9z" />
            </svg>
          }
        />

        {/* UX-3 — Review queue. Stories/StoryDetail were implemented but unreachable. */}
        <NavItem
          to="/stories"
          label="Review"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          }
        />

        <NavItem
          to="/channels"
          label="Channels"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          }
        />

        <NavItem
          to="/uat"
          label="UAT"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="m9 11 3 3L22 4" />
            </svg>
          }
        />

        <NavItem
          to="/ceremonies"
          label="Ceremonies"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
        />

        <NavItem
          to="/retro"
          label="Retrospective"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          }
        />

        <div className="pt-4">
          <SectionLabel>Library</SectionLabel>
        </div>

        <DisabledNavItem
          label="Personas"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="m22 11-2 2-2-2" />
            </svg>
          }
        />

        <NavItem
          to="/vision"
          label="Vision"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          }
        />

        <NavItem
          to="/audit"
          label="Audit Log"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          }
        />

        {/* Round 6 Task #4: project memory — [Engineer-Sr · Sonnet · run-round6-04-project-memory] */}
        <NavItem
          to="/memory"
          label="Memory"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
          }
        />

        {/* Round 6 #5 — Cost Governance — [Engineer-Sr · Sonnet · run-round6-05-cost-governance] */}
        <NavItem
          to="/cost"
          label="Cost"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />

        <NavItem
          to="/settings"
          label="Settings"
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          }
        />

        {/* Round 7-07 — Hub Admin link: only in hub mode */}
        {/* [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops] */}
        {isHubOwner && (
          <>
            <div className="pt-4">
              <SectionLabel>Hub</SectionLabel>
            </div>
            <NavItem
              to="/hub-admin"
              label="Hub Admin"
              icon={
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                  <path d="M3 12a9 3 0 0 0 18 0" />
                </svg>
              }
            />
          </>
        )}

        {/* Pulse dot legend item — matches mock */}
        <div className="mt-2 flex items-center gap-2 px-3 py-1 text-xs text-slate-400">
          <PulseDot color="emerald" size="sm" />
          <span>Live updates active</span>
        </div>
      </div>

      <LiveTelemetryPanel />
    </nav>
  )
}
