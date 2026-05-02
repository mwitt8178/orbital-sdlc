/**
 * NeedsAttention — open escalations and blocked items.
 *
 * Hydrates from orchestration.escalations.list filtered to state in
 * {open, acknowledged}. Duplicates from prior runs (same task_id + reason)
 * are collapsed into a single row with a "(× N more)" suffix using the
 * shared escalation-dedupe helper.
 *
 * Escalation acknowledgement: there is currently no `escalations.acknowledge`
 * tRPC procedure, so the "Acknowledge" / "Dismiss all" buttons hide the
 * entries client-side via sessionStorage. When the orchestrator exposes a
 * real procedure these handlers can be swapped to a real mutation; the UX
 * stays the same.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import {
  dedupeEscalations,
  escalationReasonLabel,
  type EscalationLike,
} from '../../../utils/escalation-dedupe.js'
import { useToast } from '../../../services/use-toast.js'

const ACK_STORAGE_KEY = 'orbital.escalations.acknowledged'

function readAcked(): Set<string> {
  if (typeof sessionStorage === 'undefined') return new Set()
  try {
    const raw = sessionStorage.getItem(ACK_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeAcked(values: Set<string>): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(Array.from(values)))
  } catch {
    // ignore
  }
}

interface RawEscalation {
  escalationId: string
  taskId: string
  reason: string | null
  state: string
  createdAt: string | Date
  context?: Record<string, unknown> | null
}

export function NeedsAttention() {
  const query = trpc.orchestration.escalations.list.useQuery({
    state: ['open', 'acknowledged'],
    limit: 100,
  })
  const toast = useToast()
  const [acked, setAcked] = useState<Set<string>>(() => readAcked())

  useEffect(() => {
    writeAcked(acked)
  }, [acked])

  const items = useMemo(() => {
    const raw = ((query.data?.items ?? []) as RawEscalation[]).map<EscalationLike>((e) => ({
      escalationId: e.escalationId,
      taskId: e.taskId,
      reason: e.reason,
      state: e.state,
      createdAt: e.createdAt,
      ...(e.context ? { context: e.context } : {}),
    }))
    const deduped = dedupeEscalations(raw)
    return deduped.filter((d) => !acked.has(`${d.taskId}::${d.reason ?? 'unknown'}`))
  }, [query.data, acked])

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton rows={3} />
      </div>
    )
  }

  if (query.error) {
    return <ErrorMessage title="Could not load escalations" message={query.error.message} />
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing needs your attention"
        description="Escalations, UAT-ready items, and blockers will appear here."
      />
    )
  }

  const acknowledge = (taskId: string, reason: string | null | undefined) => {
    const key = `${taskId}::${reason ?? 'unknown'}`
    setAcked((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    toast.success('Escalation acknowledged', {
      description: escalationReasonLabel(reason),
      action: {
        label: 'Undo',
        onClick: () => {
          setAcked((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        },
      },
    })
  }

  const dismissAll = () => {
    const keys = items.map((i) => `${i.taskId}::${i.reason ?? 'unknown'}`)
    setAcked((prev) => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      return next
    })
    toast.success(`Dismissed ${items.length} escalation${items.length === 1 ? '' : 's'}`)
  }

  return (
    <div className="space-y-2" role="list">
      {items.length > 1 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={dismissAll}>
            Dismiss all
          </Button>
        </div>
      ) : null}
      {items.map((esc) => {
        const key = `${esc.taskId}::${esc.reason ?? 'unknown'}`
        return (
          <div
            key={key}
            role="listitem"
            className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge color="amber">{esc.state}</Badge>
                <span className="text-sm font-semibold text-slate-900">
                  {escalationReasonLabel(esc.reason)}
                </span>
                {esc.duplicateCount > 0 ? (
                  <span className="text-xs text-slate-500">(× {esc.duplicateCount} more)</span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-500" title={esc.escalationId}>
                task {esc.taskId.slice(0, 8)} · {esc.escalationId.slice(0, 8)} ·{' '}
                {new Date(esc.mostRecentIso).toLocaleString()}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => acknowledge(esc.taskId, esc.reason)}
            >
              Acknowledge
            </Button>
          </div>
        )
      })}
    </div>
  )
}
