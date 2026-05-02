/**
 * escalation-dedupe.ts — group duplicate escalations for the NeedsAttention
 * panel.
 *
 * Composite key: `${task_id}::${reason}`. Within a group we keep the most
 * recent record (createdAt DESC) and emit a `duplicateCount` for the rest, so
 * the UI can render `(× N more)` without the operator scrolling through
 * identical rows from prior test runs.
 *
 * Pure helper; no React dependency. Exported so the dashboard owner can
 * import from a stable path:
 *
 *   import { dedupeEscalations } from '../../utils/escalation-dedupe.js'
 */

export interface EscalationLike {
  escalationId: string
  taskId: string
  reason: string | null | undefined
  state: string
  createdAt: string | Date
  context?: Record<string, unknown> | null
}

export interface DedupedEscalation extends EscalationLike {
  /** Number of older duplicate escalations rolled into this representative. */
  duplicateCount: number
  /** All escalation ids (most-recent first) collapsed into this group. */
  groupIds: string[]
  /** ISO timestamp of the most recent occurrence (same as createdAt as ISO). */
  mostRecentIso: string
}

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  // Tolerate already-iso or random formats: parse and re-emit.
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toISOString()
}

function compositeKey(item: EscalationLike): string {
  const reason = item.reason ?? 'unknown'
  return `${item.taskId}::${reason}`
}

/**
 * Group escalations by (task_id, reason). The representative entry is the
 * most recent occurrence; older duplicates contribute to `duplicateCount`.
 *
 * The output list is sorted by `mostRecentIso` DESC so the freshest groups
 * appear first.
 */
export function dedupeEscalations<T extends EscalationLike>(
  items: readonly T[],
): DedupedEscalation[] {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const key = compositeKey(item)
    const existing = buckets.get(key)
    if (existing) {
      existing.push(item)
    } else {
      buckets.set(key, [item])
    }
  }

  const out: DedupedEscalation[] = []
  for (const group of buckets.values()) {
    group.sort((a, b) => {
      const aIso = toIso(a.createdAt)
      const bIso = toIso(b.createdAt)
      if (aIso === bIso) return 0
      return aIso < bIso ? 1 : -1
    })
    const head = group[0]
    if (!head) continue
    out.push({
      ...head,
      duplicateCount: group.length - 1,
      groupIds: group.map((g) => g.escalationId),
      mostRecentIso: toIso(head.createdAt),
    })
  }

  out.sort((a, b) => {
    if (a.mostRecentIso === b.mostRecentIso) return 0
    return a.mostRecentIso < b.mostRecentIso ? 1 : -1
  })
  return out
}

/**
 * Convenience: returns a stable label for a reason enum.
 */
export function escalationReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'retry_budget_exhausted':
      return 'Retry budget exhausted'
    case 'timeout_after_retries':
      return 'Timed out after retries'
    case 'blocker_unresolvable':
      return 'Blocker unresolvable'
    case 'disagreement_unresolvable':
      return 'Disagreement unresolvable'
    case 'hook_rejected_critical':
      return 'Hook rejected (critical)'
    case 'manual_admin_kill':
      return 'Admin kill'
    default:
      return 'Escalation'
  }
}
