/**
 * store/workers.ts — agent worker registry derived from
 * orchestration.workers.list and AgentSpawned/Heartbeat/Completed/...
 * events streamed via WS.
 *
 * The store is a thin client cache. Authoritative state always lives on the
 * server; we keep the last-known view per worker_id keyed for fast renders.
 *
 * Round5B — also keeps a per-worker recent-output buffer fed by
 * WorkerOutputLine events. The buffer caps at WORKER_OUTPUT_BUFFER_CAP
 * lines per worker; older lines are dropped to keep memory bounded.
 */

import { create } from 'zustand'

export type WorkerStatus =
  | 'connecting'
  | 'active'
  | 'idle'
  | 'terminating'
  | 'terminated'

export interface WorkerView {
  workerId: string
  taskId: string | null
  personaRole: string | null
  model: string | null
  status: WorkerStatus
  startedAt: string
  lastHeartbeatAt: string | null
  /** Optional file path the worker is currently editing (from Heartbeat payload). */
  currentFile?: string | null
}

export interface WorkerOutputLineView {
  lineSeq: number
  stream: 'stdout' | 'stderr'
  line: string
  occurredAt: string
}

/** Per-worker buffer cap. The orchestrator's stream registry mirrors 200. */
export const WORKER_OUTPUT_BUFFER_CAP = 500

interface WorkersState {
  workersById: Record<string, WorkerView>
  outputByWorkerId: Record<string, WorkerOutputLineView[]>
  setWorkers: (workers: WorkerView[]) => void
  upsertWorker: (worker: WorkerView) => void
  removeWorker: (workerId: string) => void
  appendOutputLine: (workerId: string, line: WorkerOutputLineView) => void
  /** Bulk-set the recent buffer (used by tRPC backfill on drawer open). */
  setOutputBuffer: (workerId: string, lines: WorkerOutputLineView[]) => void
  clearOutput: (workerId: string) => void
  reset: () => void
}

export const useWorkersStore = create<WorkersState>((set) => ({
  workersById: {},
  outputByWorkerId: {},
  setWorkers: (workers) =>
    set({
      workersById: Object.fromEntries(workers.map((w) => [w.workerId, w])),
    }),
  upsertWorker: (worker) =>
    set((state) => ({
      workersById: { ...state.workersById, [worker.workerId]: worker },
    })),
  removeWorker: (workerId) =>
    set((state) => {
      if (!(workerId in state.workersById)) return state
      const { [workerId]: _removed, ...rest } = state.workersById
      return { workersById: rest }
    }),
  appendOutputLine: (workerId, line) =>
    set((state) => {
      const existing = state.outputByWorkerId[workerId] ?? []
      // De-dup by lineSeq if the same line happens to flow in twice.
      if (existing.some((l) => l.lineSeq === line.lineSeq)) return state
      const next = [...existing, line]
      if (next.length > WORKER_OUTPUT_BUFFER_CAP) {
        next.splice(0, next.length - WORKER_OUTPUT_BUFFER_CAP)
      }
      return {
        outputByWorkerId: { ...state.outputByWorkerId, [workerId]: next },
      }
    }),
  setOutputBuffer: (workerId, lines) =>
    set((state) => {
      const trimmed =
        lines.length > WORKER_OUTPUT_BUFFER_CAP
          ? lines.slice(lines.length - WORKER_OUTPUT_BUFFER_CAP)
          : [...lines]
      return {
        outputByWorkerId: { ...state.outputByWorkerId, [workerId]: trimmed },
      }
    }),
  clearOutput: (workerId) =>
    set((state) => {
      if (!(workerId in state.outputByWorkerId)) return state
      const { [workerId]: _removed, ...rest } = state.outputByWorkerId
      return { outputByWorkerId: rest }
    }),
  reset: () => set({ workersById: {}, outputByWorkerId: {} }),
}))

/** Selector: all workers currently in active or idle state, sorted by startedAt desc. */
export function selectActiveWorkers(state: WorkersState): WorkerView[] {
  return Object.values(state.workersById)
    .filter((w) => w.status === 'active' || w.status === 'idle' || w.status === 'connecting')
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/** Selector: recent output lines for a given worker (newest last). */
export function selectWorkerOutput(
  state: WorkersState,
  workerId: string,
): WorkerOutputLineView[] {
  return state.outputByWorkerId[workerId] ?? []
}
