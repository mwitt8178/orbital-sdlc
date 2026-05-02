import clsx from 'clsx'

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
  label?: string
}

export function Spinner({ size = 'md', className, label = 'Loading…' }: SpinnerProps) {
  const sizeClass = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' }[size]

  return (
    <svg
      className={clsx('animate-spin text-brand-500', sizeClass, className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-label={label}
      role="status"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}
