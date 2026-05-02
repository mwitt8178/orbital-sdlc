import clsx from 'clsx'
import { ReactNode } from 'react'

type BadgeColor =
  | 'emerald'
  | 'violet'
  | 'amber'
  | 'blue'
  | 'rose'
  | 'slate'
  | 'indigo'
  | 'purple'

interface BadgeProps {
  color?: BadgeColor
  children: ReactNode
  className?: string
}

const colorMap: Record<BadgeColor, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
}

export function Badge({ color = 'slate', children, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        colorMap[color],
        className,
      )}
    >
      {children}
    </span>
  )
}
