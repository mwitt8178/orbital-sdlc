import clsx from 'clsx'
import { InputHTMLAttributes, forwardRef } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  hasError?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ hasError, className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={clsx(
          'w-full rounded-md border px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-none transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60',
          hasError ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white',
          className,
        )}
        {...props}
      />
    )
  },
)

Input.displayName = 'Input'
