/**
 * InlineValidationField — text/password input that surfaces inline validation
 * messages immediately on blur (and live as the user types when there is
 * already an error).
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Acceptance criteria #5: bad Anthropic key → specific error within 200ms.
 *
 * Validation runs synchronously via the `validate` prop. The component
 * renders the message produced by `validate(value)` and applies the
 * red-border / aria-invalid affordances when there is an error.
 */

import clsx from 'clsx'
import {
  ChangeEvent,
  FocusEvent,
  InputHTMLAttributes,
  useId,
  useMemo,
  useState,
} from 'react'

export interface InlineValidationFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'onBlur'> {
  label: string
  helperText?: string
  /** Synchronous validator. Return null when valid; a string message otherwise. */
  validate?: (value: string) => string | null
  /** Called with the latest value on every change. */
  onValueChange?: (value: string) => void
  /** Optional callback fired with the latest validation status. */
  onValidityChange?: (valid: boolean, message: string | null) => void
  /** Initial value (uncontrolled). */
  defaultValue?: string
  /** Controlled value — when supplied, takes precedence over internal state. */
  value?: string
}

export function InlineValidationField({
  label,
  helperText,
  validate,
  onValueChange,
  onValidityChange,
  defaultValue,
  value,
  className,
  type = 'text',
  ...rest
}: InlineValidationFieldProps) {
  const reactId = useId()
  const id = rest.id ?? reactId

  const [internal, setInternal] = useState<string>(defaultValue ?? '')
  const [touched, setTouched] = useState(false)

  const effectiveValue = value !== undefined ? value : internal

  const errorMessage = useMemo<string | null>(() => {
    if (!validate) return null
    if (!touched && effectiveValue.length === 0) return null
    return validate(effectiveValue)
  }, [validate, touched, effectiveValue])

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value
    if (value === undefined) setInternal(next)
    onValueChange?.(next)
    if (onValidityChange) {
      const v = validate ? validate(next) : null
      onValidityChange(v === null, v)
    }
  }

  const handleBlur = (_e: FocusEvent<HTMLInputElement>) => {
    setTouched(true)
    if (onValidityChange && validate) {
      const v = validate(effectiveValue)
      onValidityChange(v === null, v)
    }
  }

  const hasError = errorMessage !== null

  return (
    <div className={clsx('w-full', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={effectiveValue}
        onChange={handleChange}
        onBlur={handleBlur}
        aria-invalid={hasError ? 'true' : 'false'}
        aria-describedby={hasError ? `${id}-error` : helperText ? `${id}-help` : undefined}
        className={clsx(
          'mt-1 block w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1',
          hasError
            ? 'border-red-400 focus:border-red-500 focus:ring-red-500'
            : 'border-slate-300 focus:border-brand-500 focus:ring-brand-500',
        )}
        {...rest}
      />
      {hasError && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-600">
          {errorMessage}
        </p>
      )}
      {!hasError && helperText && (
        <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">
          {helperText}
        </p>
      )}
    </div>
  )
}
