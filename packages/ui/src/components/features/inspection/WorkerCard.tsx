/**
 * WorkerCard — summary card for a single agent worker.
 *
 * Per architecture.md:
 *   Header: persona avatar, model badge, state badge, worker_id (short)
 *   Body: task title + ticket id, "Doing now" label, LiveCostMeter, skills row
 *   Footer: started X ago · last activity Y ago · KillButton (admin only)
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import clsx from 'clsx'
import type { WorkerInspection } from './types.js'
import { LiveCostMeter } from './LiveCostMeter.js'
// Round 7-08 — Operator-Attributed UI: operator badge in card header
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../../identity/OperatorBadge.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(isoString: string): string {
  const ms = Date.now() - Date.parse(isoString)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

function stateColor(state: WorkerInspection['state']): string {
  switch (state) {
    case 'running': return 'bg-emerald-100 text-emerald-700'
    case 'briefing': return 'bg-blue-100 text-blue-700'
    case 'awaiting': return 'bg-amber-100 text-amber-700'
    case 'idle': return 'bg-slate-100 text-slate-600'
    case 'terminating': return 'bg-orange-100 text-orange-700'
    case 'terminated': return 'bg-red-100 text-red-700'
    default: return 'bg-slate-100 text-slate-500'
  }
}

function doingNow(inspection: WorkerInspection): string {
  const lastTool = inspection.recentToolCalls.at(-1)
  const lastLLM = inspection.recentLLMCalls.at(-1)

  if (lastTool && lastTool.status === 'pending') {
    return `Running tool: ${lastTool.name}`
  }
  if (lastLLM && lastLLM.status === 'pending') {
    return `Calling ${lastLLM.model}`
  }
  if (lastTool) return `Last: ${lastTool.name} (${lastTool.status})`
  if (lastLLM) return `Last LLM: ${lastLLM.model}`
  return inspection.state === 'briefing' ? 'Loading brief…' : 'Waiting'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface WorkerCardProps {
  inspection: WorkerInspection
  onSelect: (workerId: string) => void
  /** Pulse when new event received in last 2s (passed from parent). */
  pulsing?: boolean
  /**
   * Round 7-08 — Operator-Attributed UI
   * Team member data for the install that owns this worker.
   * When provided, an OperatorBadge is shown in the card header.
   */
  operator?: TeamMember
}

export function WorkerCard({ inspection, onSelect, pulsing = false, operator }: WorkerCardProps) {
  const shortId = inspection.workerId.slice(0, 8)

  return (
    <button
      type="button"
      onClick={() => onSelect(inspection.workerId)}
      className="group relative flex w-full flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {/* Pulse indicator */}
      {pulsing && (
        <span
          className="absolute right-3 top-3 h-2 w-2 rounded-full bg-emerald-500 animate-pulse"
          aria-hidden="true"
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-800 truncate">
              {inspection.persona.name}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              {inspection.persona.tier}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-400">{shortId}</div>
          {/* Round 7-08 — Operator badge in WorkerCard header */}
          {operator && (
            <div className="mt-1">
              <OperatorBadge
                installId={operator.install_id}
                member={operator}
                size="sm"
                showPresence
              />
            </div>
          )}
        </div>
        <span
          className={clsx(
            'flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
            stateColor(inspection.state),
          )}
        >
          {inspection.state}
        </span>
      </div>

      {/* Body */}
      <div className="space-y-2">
        {/* Task + ticket */}
        <div className="text-xs text-slate-600 truncate">
          {inspection.ticketId && (
            <span className="mr-1 rounded bg-brand-50 px-1 py-0.5 font-mono text-[10px] text-brand-600">
              {inspection.ticketId}
            </span>
          )}
          <span className="font-mono text-[10px] text-slate-400">{inspection.taskId.slice(0, 8)}</span>
        </div>

        {/* Doing now */}
        <div className="text-xs text-slate-500 truncate">{doingNow(inspection)}</div>

        {/* LiveCostMeter */}
        {inspection.costBudgetForScope && (
          <LiveCostMeter
            pctUsed={inspection.costBudgetForScope.pctUsed}
            costUsd={inspection.costToDate.usd}
            hardCap={inspection.costBudgetForScope.hardCap}
            compact
          />
        )}

        {/* Skills row */}
        {inspection.skillsLoaded.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {inspection.skillsLoaded.slice(0, 5).map((s) => (
              <span
                key={s.id}
                className="rounded-sm bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-500"
                title={`sha: ${s.sourceSha256}`}
              >
                {s.id}
              </span>
            ))}
            {inspection.skillsLoaded.length > 5 && (
              <span className="text-[10px] text-slate-400">+{inspection.skillsLoaded.length - 5}</span>
            )}
          </div>
        )}

        {/* Recent channel posts (Round 6 #9) — shows agent-to-agent collab */}
        {inspection.recentChannelPosts.length > 0 && (
          <div className="space-y-0.5 border-t border-slate-100 pt-2">
            {inspection.recentChannelPosts.slice(0, 3).map((post, idx) => (
              <div
                key={`${post.postedAt}-${idx}`}
                className="flex items-baseline gap-1.5 text-[11px] text-slate-500"
                title={post.bodyExcerpt}
              >
                <span className="rounded-sm bg-violet-50 px-1 font-mono text-[10px] text-violet-700">
                  {post.channel}
                </span>
                <span className="truncate">{post.bodyExcerpt}</span>
              </div>
            ))}
            {inspection.recentChannelPosts.length > 3 && (
              <div className="text-[10px] text-slate-400">
                +{inspection.recentChannelPosts.length - 3} more posts
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>started {relativeTime(inspection.startedAt)}</span>
        <span>active {relativeTime(inspection.lastActivityAt)}</span>
      </div>
    </button>
  )
}
