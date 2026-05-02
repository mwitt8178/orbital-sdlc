import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PulseDot } from '../ui/PulseDot.js'
import { useConnectionStore } from '../../store/connection.js'
import { useSprintsStore } from '../../store/sprints.js'
import { useCommandRegistry } from '../../services/command-registry.js'
import { ProjectSwitcher } from '../features/projects/ProjectSwitcher.js'
import { trpc } from '../../services/trpc.js'
import { useActiveProjectStore } from '../../store/active-project.js'
import type { CostLedgerAppendedPayload } from '../../types/events.js'
// Round 7-02 — hub status indicator in topbar
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { HubStatusIndicator } from './HubStatusIndicator.js'

/** Orbital logo box — indigo→violet gradient, 28×28. */
function LogoBox() {
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2a10 10 0 0 1 8.66 5" />
        <path d="M22 12a10 10 0 0 1-5 8.66" />
        <path d="M12 22a10 10 0 0 1-8.66-5" />
        <path d="M2 12a10 10 0 0 1 5-8.66" />
      </svg>
    </div>
  )
}

function SprintStatusPill() {
  const activeSprint = useSprintsStore((s) => s.activeSprint)
  const connectionStatus = useConnectionStore((s) => s.status)

  if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs">
        <PulseDot color="slate" />
        <span className="font-medium text-slate-500">
          {connectionStatus === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
      </div>
    )
  }

  if (!activeSprint) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs">
        <PulseDot color="slate" pulse={false} />
        <span className="font-medium text-slate-500">No active sprint</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs">
      <PulseDot color="emerald" />
      <span className="font-medium text-emerald-700">{activeSprint.name} active</span>
    </div>
  )
}

/**
 * LiveBurnWidget — shows "$spent / $cap today" with colour-coded progress bar.
 * Subscribes to CostLedgerAppended events over the existing WS connection for
 * live updates. Clicking navigates to the /cost page.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */
function LiveBurnWidget() {
  const navigate = useNavigate()
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)
  const [liveCost, setLiveCost] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const summaryQ = trpc.cost.summary.useQuery(
    { projectId: activeProjectId ?? '' },
    {
      enabled: !!activeProjectId,
      staleTime: 30_000,
      refetchInterval: 30_000,
    },
  )

  // Subscribe to WS cost events for live updates
  useEffect(() => {
    if (!activeProjectId) return
    const ws = new WebSocket(`ws://${window.location.host}/ws`)
    wsRef.current = ws
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type?: string; payload?: unknown }
        if (msg.type === 'CostLedgerAppended') {
          const p = msg.payload as CostLedgerAppendedPayload
          if (p.project_id === activeProjectId) {
            setLiveCost((prev) => (prev ?? summaryQ.data?.totalCostUsd ?? 0) + p.cost_usd)
          }
        }
      } catch {
        // ignore malformed frames
      }
    }
    return () => ws.close()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const totalCostUsd = liveCost ?? summaryQ.data?.totalCostUsd ?? 0
  const hardCapUsd   = summaryQ.data?.hardCapUsd ?? null
  const pct          = hardCapUsd && hardCapUsd > 0 ? Math.min(1, totalCostUsd / hardCapUsd) : 0

  if (!activeProjectId) return null

  const barColor =
    pct >= 1.0 ? 'bg-red-500 animate-pulse' :
    pct >= 0.8 ? 'bg-amber-500' :
    pct >= 0.5 ? 'bg-yellow-400' :
    'bg-emerald-500'

  const textColor =
    pct >= 1.0 ? 'text-red-700' :
    pct >= 0.8 ? 'text-amber-700' :
    'text-slate-700'

  return (
    <button
      type="button"
      onClick={() => navigate('/cost')}
      className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label="View cost dashboard"
      title="Click to open cost dashboard"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="text-slate-400"
      >
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
      <span className={`font-mono font-medium ${textColor}`}>
        ${totalCostUsd.toFixed(2)}
        {hardCapUsd != null && <> / ${hardCapUsd.toFixed(2)}</>}
      </span>
      {hardCapUsd != null && (
        <div className="relative h-1 w-16 overflow-hidden rounded-full bg-slate-200">
          <div
            className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
      )}
    </button>
  )
}

export function TopBar() {
  const openPalette = useCommandRegistry((s) => s.open)

  return (
    <header className="border-b border-slate-200 bg-white" role="banner">
      <div className="flex items-center justify-between px-5 py-3">
        {/* Left: logo + project switcher */}
        <div className="flex items-center gap-3">
          <LogoBox />
          <span className="font-semibold text-slate-900">Orbital</span>
          <span className="text-xs text-slate-400" aria-hidden="true">
            /
          </span>
          <ProjectSwitcher />
        </div>

        {/* Right: search stub, sprint pill, avatar */}
        <div className="flex items-center gap-3">
          {/* Command palette trigger */}
          <button
            type="button"
            onClick={openPalette}
            className="hidden items-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:flex"
            aria-label="Open command palette (⌘K)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span>Search or type a command</span>
            <span className="ml-2 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              ⌘K
            </span>
          </button>

          {/* Round 6 #5 — Live cost burn widget */}
          {/* [Engineer-Sr · Sonnet · run-round6-05-cost-governance] */}
          <LiveBurnWidget />

          {/* Round 7-02 — hub connection status */}
          {/* [Engineer-Sr · Sonnet · run-round7-02-local-hub-split] */}
          <HubStatusIndicator />

          <SprintStatusPill />

          {/* User avatar */}
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-600"
            aria-label="Signed in as MW"
          >
            MW
          </div>
        </div>
      </div>
    </header>
  )
}
