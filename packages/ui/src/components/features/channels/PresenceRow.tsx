/**
 * PresenceRow — avatar strip of users/personas currently in a channel.
 *
 * Pulls presence from the workers store (last heartbeat < 90 s).
 * When no presence data is available, renders nothing.
 */

import { useWorkersStore, type WorkerView } from '../../../store/workers.js'

interface PresenceRowProps {
  channelId: string
}

/** How long (ms) before a heartbeat is considered stale. */
const PRESENCE_TTL_MS = 90_000

export function PresenceRow({ channelId: _channelId }: PresenceRowProps) {
  const workersById = useWorkersStore((s) => s.workersById)

  const now = Date.now()
  const present: WorkerView[] = Object.values(workersById).filter((w) => {
    if (!w.lastHeartbeatAt) return false
    const age = now - new Date(w.lastHeartbeatAt).getTime()
    return age < PRESENCE_TTL_MS
  })

  if (present.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 px-5 pb-1.5 pt-1" aria-label="Active participants">
      <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
        Active
      </span>
      <div className="flex -space-x-1.5">
        {present.slice(0, 8).map((w) => {
          const label = w.personaRole ?? w.workerId
          const initials = label.slice(0, 2).toUpperCase()
          return (
            <div
              key={w.workerId}
              title={label}
              aria-label={`${label} is active`}
              className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-indigo-500 to-violet-600 text-[8px] font-bold text-white"
            >
              {initials}
            </div>
          )
        })}
        {present.length > 8 && (
          <div
            aria-label={`${present.length - 8} more active participants`}
            className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-slate-200 text-[8px] font-bold text-slate-600"
          >
            +{present.length - 8}
          </div>
        )}
      </div>
    </div>
  )
}
