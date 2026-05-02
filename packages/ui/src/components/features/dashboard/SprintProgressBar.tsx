/**
 * SprintProgressBar — 4-segment progress bar matching the prototype, plus
 * an optional "Day N of M" counter when the caller supplies the sprint
 * timing fields.
 *
 * Done / In review / Blocked / Pending. Counts derive from caller-supplied
 * task-state aggregations. When totals are zero, render a single slate-200
 * segment so the UI is never blank.
 */

const DAY_MS = 86_400_000
const DEFAULT_SPRINT_DAYS = 5

interface SprintProgressBarProps {
  done: number
  inReview: number
  blocked: number
  pending: number
  /** Sprint start timestamp (ISO). When null, day counter is hidden. */
  startedAt?: string | null
  /** Wall-clock target in milliseconds. Falls back to 5 days when null. */
  wallClockTargetMs?: number | null
}

export function SprintProgressBar({
  done,
  inReview,
  blocked,
  pending,
  startedAt,
  wallClockTargetMs,
}: SprintProgressBarProps) {
  const total = done + inReview + blocked + pending
  const safeTotal = total > 0 ? total : 1
  const segments = [
    { count: done, color: 'bg-emerald-500', label: 'Done' },
    { count: inReview, color: 'bg-violet-500', label: 'In review' },
    { count: blocked, color: 'bg-amber-400', label: 'Blocked' },
    { count: pending, color: 'bg-slate-300', label: 'Pending' },
  ]

  const dayCounter = computeDayCounter(startedAt, wallClockTargetMs)

  return (
    <div className="mb-6">
      {dayCounter && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700" aria-label="Sprint day counter">
            Day {dayCounter.day} of {dayCounter.totalDays}
          </span>
          <span className="text-xs text-slate-500">
            {Math.max(0, dayCounter.totalDays - dayCounter.day)} day
            {Math.max(0, dayCounter.totalDays - dayCounter.day) === 1 ? '' : 's'} remaining
          </span>
        </div>
      )}
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Sprint progress: ${done} of ${total} tasks done`}
      >
        {total === 0 ? (
          <div className="bg-slate-200" style={{ width: '100%' }} />
        ) : (
          segments.map((seg) => (
            <div
              key={seg.label}
              className={seg.color}
              style={{ width: `${(seg.count / safeTotal) * 100}%` }}
              aria-hidden="true"
            />
          ))
        )}
      </div>
      <div className="mt-2 flex gap-5 text-xs text-slate-500">
        <LegendItem dotClass="bg-emerald-500" label={`Done (${done})`} />
        <LegendItem dotClass="bg-violet-500" label={`In review (${inReview})`} />
        <LegendItem dotClass="bg-amber-400" label={`Blocked (${blocked})`} />
        <LegendItem dotClass="bg-slate-300" label={`Pending (${pending})`} />
      </div>
    </div>
  )
}

function LegendItem({ dotClass, label }: { dotClass: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      {label}
    </div>
  )
}

function computeDayCounter(
  startedAt: string | null | undefined,
  wallClockTargetMs: number | null | undefined,
): { day: number; totalDays: number } | null {
  if (!startedAt) return null
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return null
  const elapsedDays = Math.max(1, Math.ceil((Date.now() - started) / DAY_MS))
  const totalDays = wallClockTargetMs
    ? Math.max(1, Math.ceil(wallClockTargetMs / DAY_MS))
    : DEFAULT_SPRINT_DAYS
  return { day: Math.min(elapsedDays, totalDays + 30), totalDays }
}
