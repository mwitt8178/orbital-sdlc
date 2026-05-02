import clsx from 'clsx'

interface SkeletonProps {
  className?: string
  /** Number of rows to repeat (useful for list skeletons) */
  rows?: number
}

function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'animate-pulse rounded bg-slate-200',
        className,
      )}
      aria-hidden="true"
    />
  )
}

export function Skeleton({ className, rows = 1 }: SkeletonProps) {
  if (rows === 1) {
    return <SkeletonLine className={clsx('h-4 w-full', className)} />
  }
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine
          key={i}
          className={clsx('h-4', i === rows - 1 ? 'w-3/4' : 'w-full', className)}
        />
      ))}
    </div>
  )
}

/** A card-shaped skeleton block matching the mock agent card proportions. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)}
      aria-hidden="true"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <div className="h-8 w-8 animate-pulse rounded-md bg-slate-200" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-slate-200" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-slate-200" />
        </div>
      </div>
      <div className="h-3.5 w-3/4 animate-pulse rounded bg-slate-200" />
    </div>
  )
}
