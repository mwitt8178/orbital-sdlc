/**
 * dag.ts — DAG construction and ready-set computation.
 *
 * Per TRD-04 v0.2 §7.1, §7.2.2, §7.2.3.
 *
 * Public API:
 *   - buildDAG(tasks, dependencies)               → topological sort + cycle detection
 *   - computeReadySet(tasks, dependencies)        → tasks whose blocking predecessors are all done
 *   - assertAcyclic(tasks, edges)                 → throws INTERNAL_DAG_CYCLE on a cycle
 *
 * The Scheduler consumes computeReadySet on every tick. buildDAG is used by
 * the SprintService (Phase 4B) when it builds a fresh DAG from a sprint commitment.
 */

import { OrbitalError } from '@orbital/types'

// ---------------------------------------------------------------------------
// Lightweight task / edge interfaces — decoupled from Drizzle row shapes so
// the SprintService can call buildDAG with synthetic objects during DAG creation
// before any rows have been inserted.
// ---------------------------------------------------------------------------

export interface DagNode {
  taskId: string
  state?: string
}

export interface DagEdge {
  predecessorTaskId: string
  successorTaskId: string
  /** Defaults to true if absent. */
  blocking?: boolean
}

export interface DagBuildResult {
  /** Tasks in topological order (predecessors first). */
  topoOrder: string[]
  /** Tasks with no predecessors — initial ready-set candidates. */
  roots: string[]
  /** taskId → ids of its (incoming) predecessor edges (blocking only). */
  predecessorsOf: Map<string, Set<string>>
  /** taskId → ids of its (outgoing) successor edges. */
  successorsOf: Map<string, Set<string>>
}

// ---------------------------------------------------------------------------
// buildDAG — topological sort with cycle detection
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 §7.2.2. Computes a topological order over the given nodes/edges,
 * raising INTERNAL_DAG_CYCLE if a cycle exists.
 *
 * Only edges where blocking !== false participate in topology — informational
 * edges are recorded in successorsOf but not enforced.
 */
export function buildDAG(nodes: DagNode[], edges: DagEdge[]): DagBuildResult {
  const allIds = new Set(nodes.map((n) => n.taskId))
  const predecessorsOf = new Map<string, Set<string>>()
  const successorsOf = new Map<string, Set<string>>()

  for (const n of nodes) {
    predecessorsOf.set(n.taskId, new Set())
    successorsOf.set(n.taskId, new Set())
  }

  for (const e of edges) {
    if (!allIds.has(e.predecessorTaskId) || !allIds.has(e.successorTaskId)) {
      throw new OrbitalError(
        'INTERNAL_DAG_CYCLE',
        `task_dependencies refers to unknown task: ${e.predecessorTaskId} -> ${e.successorTaskId}`,
      )
    }
    if (e.blocking === false) {
      // informational: track in successorsOf for retro/audit, skip from topology
      successorsOf.get(e.predecessorTaskId)!.add(e.successorTaskId)
      continue
    }
    predecessorsOf.get(e.successorTaskId)!.add(e.predecessorTaskId)
    successorsOf.get(e.predecessorTaskId)!.add(e.successorTaskId)
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>()
  for (const [id, preds] of predecessorsOf) inDegree.set(id, preds.size)

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  // Stable order: sort root queue by taskId so the output is deterministic.
  queue.sort()

  const roots = [...queue]
  const topoOrder: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    topoOrder.push(id)
    const succ = successorsOf.get(id)
    if (!succ) continue
    // Decrement in-degree only for blocking successors.
    const blockingSucc: string[] = []
    for (const s of succ) {
      const sPreds = predecessorsOf.get(s)
      if (sPreds && sPreds.has(id)) blockingSucc.push(s)
    }
    blockingSucc.sort() // deterministic ordering
    for (const s of blockingSucc) {
      const next = (inDegree.get(s) ?? 0) - 1
      inDegree.set(s, next)
      if (next === 0) queue.push(s)
    }
  }

  if (topoOrder.length !== nodes.length) {
    const remaining = [...allIds].filter((id) => !topoOrder.includes(id))
    throw new OrbitalError(
      'INTERNAL_DAG_CYCLE',
      `task_dependencies form a cycle involving: ${remaining.join(', ')}`,
      { cycle_members: remaining },
    )
  }

  return { topoOrder, roots, predecessorsOf, successorsOf }
}

// ---------------------------------------------------------------------------
// assertAcyclic — convenience wrapper used by SprintService
// ---------------------------------------------------------------------------

export function assertAcyclic(nodes: DagNode[], edges: DagEdge[]): void {
  buildDAG(nodes, edges)
}

// ---------------------------------------------------------------------------
// computeReadySet — tasks whose blocking predecessors are all done
// ---------------------------------------------------------------------------

/**
 * Per TRD-04 §7.1 (transition table row pending -> ready).
 *
 * @param tasks  Tasks to consider; only those in state 'pending' or 'ready' are returned.
 * @param edges  Dependency edges across the relevant tasks.
 * @returns      taskIds whose blocking predecessors are all in state 'done'.
 */
export function computeReadySet(tasks: DagNode[], edges: DagEdge[]): string[] {
  const stateOf = new Map<string, string>()
  for (const t of tasks) stateOf.set(t.taskId, t.state ?? 'pending')

  const blockingPreds = new Map<string, string[]>()
  for (const t of tasks) blockingPreds.set(t.taskId, [])
  for (const e of edges) {
    if (e.blocking === false) continue
    blockingPreds.get(e.successorTaskId)?.push(e.predecessorTaskId)
  }

  const ready: string[] = []
  for (const t of tasks) {
    const state = stateOf.get(t.taskId)
    if (state !== 'pending' && state !== 'ready') continue
    const preds = blockingPreds.get(t.taskId) ?? []
    const allDone = preds.every((p) => stateOf.get(p) === 'done')
    if (allDone) ready.push(t.taskId)
  }
  return ready
}
