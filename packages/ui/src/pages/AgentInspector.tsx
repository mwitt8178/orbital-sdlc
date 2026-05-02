/**
 * AgentInspector — Live factory-floor view of all active agent workers.
 *
 * Per architecture.md:
 *   - Top filter: sprint / persona / state / model
 *   - Grid of WorkerCard (one per active worker)
 *   - Click a card → opens detail drawer (full WorkerInspection)
 *   - Live updates via WS — dot pulses when worker emits a new event in last 2s
 *
 * WS subscription: 'inspection:active' for grid refresh.
 *                  'inspection:worker:<id>' when a drawer is open.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../services/trpc.js'
import { useHubSubscription } from '../hooks/useHubSubscription.js'
import { WorkerCard } from '../components/features/inspection/WorkerCard.js'
import { ToolCallTimeline } from '../components/features/inspection/ToolCallTimeline.js'
import { SkillStack } from '../components/features/inspection/SkillStack.js'
import { CapabilityScope } from '../components/features/inspection/CapabilityScope.js'
import { LiveCostMeter } from '../components/features/inspection/LiveCostMeter.js'
import { KillButton } from '../components/features/inspection/KillButton.js'
import type { WorkerInspection } from '../components/features/inspection/types.js'
// Round 7-08 — Operator-Attributed UI: operator badge + filter
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../components/identity/OperatorBadge.js'
import { OperatorFilter, type OperatorFilterValue } from '../components/identity/OperatorFilter.js'

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

interface DrawerProps {
  inspection: WorkerInspection
  isAdmin: boolean
  onClose: () => void
}

function DetailDrawer({ inspection, isAdmin, onClose }: DrawerProps) {
  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-lg flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-xl"
      role="dialog"
      aria-label={`Worker detail: ${inspection.workerId}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">{inspection.persona.name}</div>
          <div className="font-mono text-xs text-slate-400">{inspection.workerId}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Cost meter */}
        {inspection.costBudgetForScope && (
          <LiveCostMeter
            pctUsed={inspection.costBudgetForScope.pctUsed}
            costUsd={inspection.costToDate.usd}
            hardCap={inspection.costBudgetForScope.hardCap}
          />
        )}

        {/* Capability scope */}
        <CapabilityScope capability={inspection.capability} />

        {/* Skill stack */}
        <SkillStack skills={inspection.skillsLoaded} />

        {/* Tool + LLM timeline */}
        <div>
          <h3 className="mb-2 text-xs font-semibold text-slate-700">Timeline</h3>
          <ToolCallTimeline inspection={inspection} />
        </div>

        {/* Output tail */}
        {inspection.outputTail.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold text-slate-700">Recent Output</h3>
            <div className="rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-300">
              {inspection.outputTail.slice(-20).map((line, i) => (
                <div key={i} className="leading-relaxed">{line}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer — kill button */}
      <div className="border-t border-slate-200 p-4">
        <KillButton workerId={inspection.workerId} isAdmin={isAdmin} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

type StateFilter = 'all' | 'running' | 'awaiting' | 'idle' | 'terminated'

interface FilterBarProps {
  stateFilter: StateFilter
  onStateFilter: (s: StateFilter) => void
}

function FilterBar({ stateFilter, onStateFilter }: FilterBarProps) {
  const states: StateFilter[] = ['all', 'running', 'awaiting', 'idle', 'terminated']
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500">Filter:</span>
      {states.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onStateFilter(s)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            stateFilter === s
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AgentInspector() {
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  // Round 7-08 — Operator-Attributed UI: operator filter
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const [operatorFilter, setOperatorFilter] = useState<OperatorFilterValue>('all')
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 30_000 })
  const myIdQuery = trpc.team.myInstallId.useQuery(undefined, { staleTime: 60_000 })
  const myInstallId = myIdQuery.data?.install_id ?? ''
  const teamMembers: TeamMember[] = (membersQuery.data ?? []).map((m) => ({
    install_id: m.install_id,
    display_name: m.display_name,
    role: m.role,
    last_seen_at: m.last_seen_at,
    color: m.color,
  }))
  const [pulsingWorkers, setPulsingWorkers] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()

  // Fetch active workers list
  const workersQuery = trpc.orchestration.workers.list.useQuery(
    { status: ['connecting', 'active', 'idle'], limit: 100 },
    { refetchInterval: 5_000 },
  )

  // Fetch full inspection for each worker in the list
  // (Poll provides baseline; WS hub pushes real-time deltas below)
  const workerIds = workersQuery.data?.items.map((w) => w.workerId) ?? []

  // Drawer inspection data — fetched by ID when drawer is open
  const drawerInspection = trpc.orchestration.workers.inspect.useQuery(
    { worker_id: selectedWorkerId! },
    {
      enabled: !!selectedWorkerId,
      refetchInterval: 2_000,
    },
  )

  // Real-time hub subscription: worker:* receives WorkerLifecyclePhase,
  // ToolCallStarted, ToolCallCompleted, LLMRequestStarted, LLMRequestCompleted,
  // WorkerKilledByOperator, AgentChannelPosted from all installs.
  // On any matching event: invalidate the worker list + active drawer inspection
  // so the grid and drawer reflect the latest state without waiting for the
  // next poll interval.
  const workerEventTypes = new Set([
    'WorkerLifecyclePhase',
    'ToolCallStarted',
    'ToolCallCompleted',
    'LLMRequestStarted',
    'LLMRequestCompleted',
    'WorkerKilledByOperator',
    'AgentChannelPosted',
  ])

  useHubSubscription(
    'worker:*',
    (event) => {
      if (!workerEventTypes.has(event.event_type)) return

      // Invalidate the worker list so the grid refreshes with new state/count
      void queryClient.invalidateQueries({
        queryKey: [['orchestration', 'workers', 'list']],
      })

      // If the drawer is open for this worker, invalidate its inspection too
      if (selectedWorkerId) {
        const payload = event.payload as Record<string, unknown>
        const workerIdFromEvent = (payload['worker_id'] as string | undefined) ?? ''
        if (!workerIdFromEvent || workerIdFromEvent === selectedWorkerId) {
          void queryClient.invalidateQueries({
            queryKey: [['orchestration', 'workers', 'inspect'], { input: { worker_id: selectedWorkerId } }],
          })
        }
      }

      // Pulse the worker card for the worker that emitted the event
      const payload = event.payload as Record<string, unknown>
      const workerIdFromEvent = payload['worker_id'] as string | undefined
      if (workerIdFromEvent) {
        setPulsingWorkers((prev) => new Set(prev).add(workerIdFromEvent))
        setTimeout(() => {
          setPulsingWorkers((prev) => {
            const next = new Set(prev)
            next.delete(workerIdFromEvent)
            return next
          })
        }, 2000)
      }
    },
  )

  // Build minimal inspection from worker list for grid cards
  // (cards show basic data; full data only in drawer)
  type WorkerListItem = NonNullable<typeof workersQuery.data>['items'][number]

  const buildCardInspection = useCallback(
    (worker: WorkerListItem): WorkerInspection => ({
      workerId: worker.workerId,
      taskId: worker.taskId ?? '',
      persona: {
        id: worker.personaId ?? 'unknown',
        name: worker.personaId ?? 'Unknown',
        tier: 'sonnet',
      },
      model: { provider: 'anthropic', model: 'unknown' },
      state: (worker.status as WorkerInspection['state']) ?? 'starting',
      startedAt: worker.startedAt != null ? String(worker.startedAt) : new Date().toISOString(),
      lastActivityAt: worker.startedAt != null ? String(worker.startedAt) : new Date().toISOString(),
      capability: {
        scopes: { filesRead: [], filesWrite: [], channelPost: [] },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      skillsLoaded: [],
      recentLLMCalls: [],
      recentToolCalls: [],
      costToDate: { tokens: 0, usd: 0 },
      recentChannelPosts: [],
      outputTail: [],
    }),
    [],
  )

  // Pulse effect baseline: still runs on poll-driven workerIds change
  useEffect(() => {
    if (workerIds.length === 0) return
    const id = setTimeout(() => setPulsingWorkers(new Set()), 2000)
    return () => clearTimeout(id)
  }, [workerIds.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const workers = workersQuery.data?.items ?? []
  const filtered = workers.filter((w) => {
    if (stateFilter !== 'all' && w.status !== stateFilter) return false
    // Round 7-08 — Operator-Attributed UI: filter by install_id
    // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
    if (operatorFilter === 'mine') return (w as Record<string, unknown>)['installId'] === myInstallId
    if (operatorFilter !== 'all') return (w as Record<string, unknown>)['installId'] === operatorFilter
    return true
  })

  const isAdmin = false  // TODO: wire to admin capability check when auth lands

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Page header */}
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Agent Inspector</h1>
            <p className="text-sm text-slate-500">Live view of all active agent workers</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
              {workers.filter((w) => w.status === 'active').length} active
            </span>
            <button
              type="button"
              onClick={() => workersQuery.refetch()}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Refresh"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <FilterBar stateFilter={stateFilter} onStateFilter={setStateFilter} />
          {/* Round 7-08 — Operator-Attributed UI: operator filter */}
          {/* [Engineer-Sr · Sonnet · run-round7-08-operator-attribution] */}
          {teamMembers.length > 1 && (
            <OperatorFilter
              value={operatorFilter}
              onChange={setOperatorFilter}
              members={teamMembers}
              myInstallId={myInstallId}
            />
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {workersQuery.isLoading && (
          <div className="flex items-center justify-center py-16 text-sm text-slate-400">
            Loading workers…
          </div>
        )}

        {workersQuery.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
            Failed to load workers: {workersQuery.error.message}
          </div>
        )}

        {!workersQuery.isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-sm text-slate-400">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-slate-300">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
            No workers match the current filter
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((worker) => (
            <WorkerCard
              key={worker.workerId}
              inspection={buildCardInspection(worker)}
              onSelect={setSelectedWorkerId}
              pulsing={pulsingWorkers.has(worker.workerId)}
            />
          ))}
        </div>
      </div>

      {/* Detail drawer overlay */}
      {selectedWorkerId && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-30 bg-slate-900/20"
            onClick={() => setSelectedWorkerId(null)}
          />
          {drawerInspection.data ? (
            <DetailDrawer
              inspection={drawerInspection.data}
              isAdmin={isAdmin}
              onClose={() => setSelectedWorkerId(null)}
            />
          ) : (
            <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-lg items-center justify-center bg-white shadow-xl">
              <p className="text-sm text-slate-400">
                {drawerInspection.isLoading ? 'Loading…' : 'Worker not found'}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
