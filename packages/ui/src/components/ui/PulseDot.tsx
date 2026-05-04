import clsx from 'clsx'

type DotColor = 'emerald' | 'violet' | 'amber' | 'blue' | 'rose' | 'slate' | 'indigo' | 'purple'
type DotSize = 'sm' | 'md'

interface PulseDotProps {
  color?: DotColor
  size?: DotSize
  /** When true the dot pulses; when false it is static */
  pulse?: boolean
  className?: string
  label?: string
}

const colorMap: Record<DotColor, string> = {
  emerald: 'bg-emerald-500',
  violet: 'bg-violet-500',
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  rose: 'bg-rose-500',
  slate: 'bg-slate-400',
  indigo: 'bg-indigo-500',
  // UX-3: 'purple' aliased to violet for palette consistency.
  purple: 'bg-violet-500',
}

const sizeMap: Record<DotSize, string> = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
}

export function PulseDot({
  color = 'emerald',
  size = 'sm',
  pulse = true,
  className,
  label,
}: PulseDotProps) {
  return (
    <span
      role="presentation"
      aria-label={label}
      className={clsx(
        'inline-block flex-shrink-0 rounded-full',
        colorMap[color],
        sizeMap[size],
        pulse && 'animate-pulse-dot',
        className,
      )}
    />
  )
}
