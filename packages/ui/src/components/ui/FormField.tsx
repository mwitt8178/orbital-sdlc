/**
 * FormField — label + control + inline error/help text wrapper.
 *
 * Use this for every form input across the app. Handles aria-invalid,
 * aria-describedby, and required indicator consistently.
 *
 * For native inputs use `<FormField label="Name" error={...}><Input /></FormField>`.
 * The component clones the single child to inject id + aria attrs.
 */

import { Children, cloneElement, isValidElement, ReactElement, ReactNode, useId } from 'react'

interface FormFieldProps {
  label: string
  error?: string
  help?: string
  required?: boolean
  /** Override the auto-generated id (rare; for stable test selectors). */
  htmlFor?: string
  children: ReactNode
}

export function FormField({ label, error, help, required, htmlFor, children }: FormFieldProps) {
  const autoId = useId()
  const id = htmlFor ?? autoId
  const errorId = `${id}-error`
  const helpId = `${id}-help`

  // Inject id + aria-* into the child control. We expect a single child.
  const child = Children.only(children)
  const controlled = isValidElement(child)
    ? cloneElement(child as ReactElement<Record<string, unknown>>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
        'aria-describedby': error ? errorId : help ? helpId : undefined,
      })
    : child

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-rose-600" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {controlled}
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-rose-600" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="mt-1 text-[11px] text-slate-400">
          {help}
        </p>
      ) : null}
    </div>
  )
}
