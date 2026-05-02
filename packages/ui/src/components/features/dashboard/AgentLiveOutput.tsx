/**
 * AgentLiveOutput — drawer/modal that shows live stdout/stderr from a running
 * worker.
 *
 * Per Round5B brief: the operator opens this from an AgentsInFlight card,
 * sees the last 200 lines (backfilled via tRPC) and streams new lines as
 * WorkerOutputLine events arrive over WS.
 *
 * Auto-scrolls to the bottom unless the user scrolls up; a "↓ N new lines"
 * pill appears so the user can opt back into following.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import {
  useWorkersStore,
  type WorkerOutputLineView,
} from '../../../store/workers.js'
import { Modal } from '../../ui/Modal.js'

interface Props {
  workerId: string
  open: boolean
  onClose: () => void
  /** Optional friendly label for the title bar (persona slug, etc.). */
  personaLabel?: string
  /** Optional task id for the title bar context. */
  taskId?: string | null
}

export function AgentLiveOutput({
  workerId,
  open,
  onClose,
  personaLabel,
  taskId,
}: Props) {
  const linesFromStore = useWorkersStore(
    (s) => s.outputByWorkerId[workerId] ?? EMPTY,
  )
  const setOutputBuffer = useWorkersStore((s) => s.setOutputBuffer)

  // tRPC backfill — the registry on the orchestrator holds the most recent
  // 200 lines per worker, including ones the WS may have rate-limited.
  const recent = trpc.orchestration.workers.getRecentOutput.useQuery(
    { worker_id: workerId, limit: 200 },
    {
      enabled: open,
      // Re-fetch on open; WS keeps it warm afterwards.
      staleTime: 5_000,
    },
  )

  useEffect(() => {
    if (!open || !recent.data?.items) return
    const mapped: WorkerOutputLineView[] = recent.data.items.map((it) => ({
      lineSeq: it.line_seq,
      stream: it.stream,
      line: it.line,
      occurredAt: it.occurred_at,
    }))
    setOutputBuffer(workerId, mapped)
    // setOutputBuffer is a stable Zustand action; only re-run on backfill change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recent.data, workerId])

  const lines = useMemo(
    () => [...linesFromStore].sort((a, b) => a.lineSeq - b.lineSeq),
    [linesFromStore],
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        personaLabel
          ? `Live output — ${personaLabel}${taskId ? ` (task ${taskId.slice(0, 8)})` : ''}`
          : 'Live worker output'
      }
      width="max-w-3xl"
    >
      <LiveOutputBody lines={lines} loading={recent.isLoading} />
    </Modal>
  )
}

const EMPTY: WorkerOutputLineView[] = []

function LiveOutputBody({
  lines,
  loading,
}: {
  lines: WorkerOutputLineView[]
  loading: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastSeenSeqRef = useRef(0)

  // Track scroll position to decide whether to auto-stick to bottom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const stuck = distanceFromBottom < 16
      setFollowing(stuck)
      if (stuck) {
        setUnseen(0)
        lastSeenSeqRef.current = lines[lines.length - 1]?.lineSeq ?? lastSeenSeqRef.current
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [lines])

  // Auto-scroll on new lines if following.
  useEffect(() => {
    if (!following || lines.length === 0) {
      // Count unseen if user has scrolled up.
      const lastSeq = lines[lines.length - 1]?.lineSeq ?? 0
      const count = lines.filter((l) => l.lineSeq > lastSeenSeqRef.current).length
      setUnseen(count)
      return
    }
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setUnseen(0)
    lastSeenSeqRef.current = lines[lines.length - 1]?.lineSeq ?? 0
  }, [lines, following])

  function jumpToBottom() {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setFollowing(true)
    setUnseen(0)
    lastSeenSeqRef.current = lines[lines.length - 1]?.lineSeq ?? 0
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-96 overflow-auto rounded-md bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-200"
        role="log"
        aria-live="polite"
        aria-label="Live worker output"
      >
        {loading && lines.length === 0 ? (
          <p className="text-slate-500">Loading recent output...</p>
        ) : lines.length === 0 ? (
          <p className="text-slate-500">No output yet — waiting for the worker to print.</p>
        ) : (
          lines.map((l) => (
            <div key={l.lineSeq} className="flex items-start gap-2">
              <span className="shrink-0 text-[10px] text-slate-500" title={l.occurredAt}>
                {formatTime(l.occurredAt)}
              </span>
              <span className={l.stream === 'stderr' ? 'text-rose-400' : 'text-slate-200'}>
                {l.line}
              </span>
            </div>
          ))
        )}
      </div>
      {!following && unseen > 0 && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 right-3 rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white shadow-md hover:bg-brand-700"
        >
          ↓ {unseen} new {unseen === 1 ? 'line' : 'lines'}
        </button>
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso.slice(11, 19)
  }
}
