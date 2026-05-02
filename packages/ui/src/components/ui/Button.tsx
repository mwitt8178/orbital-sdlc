import clsx from 'clsx'
import { ButtonHTMLAttributes, forwardRef } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50',
          {
            'bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950':
              variant === 'primary',
            'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100':
              variant === 'secondary',
            'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800': variant === 'danger',
            'text-slate-700 hover:bg-slate-100 active:bg-slate-200': variant === 'ghost',
          },
          {
            'px-2.5 py-1 text-xs': size === 'sm',
            'px-3 py-1.5 text-sm': size === 'md',
            'px-4 py-2 text-base': size === 'lg',
          },
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)

Button.displayName = 'Button'
