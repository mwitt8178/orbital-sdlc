/**
 * Toast.tsx — a single toast card.
 *
 * Visual: white card with a 4px left border colored by severity, drop shadow,
 * close button, optional action button. Animates in via CSS keyframes.
 */

import clsx from 'clsx'
import type { Toast as ToastModel } from '../../store/toasts.js'

interface ToastProps {
  toast: ToastModel
  onDismiss: (id: string) => void
}

const KIND_BORDER: Record<ToastModel['kind'], string> = {
  success: 'border-l-emerald-500',
  error: 'border-l-rose-500',
  warn: 'border-l-amber-500',
  info: 'border-l-blue-500',
}

const KIND_ICON_BG: Record<ToastModel['kind'], string> = {
  success: 'bg-emerald-50 text-emerald-600',
  error: 'bg-rose-50 text-rose-600',
  warn: 'bg-amber-50 text-amber-600',
  info: 'bg-blue-50 text-blue-600',
}

function KindIcon({ kind }: { kind: ToastModel['kind'] }) {
  if (kind === 'success') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    )
  }
  if (kind === 'error') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  if (kind === 'warn') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

export function Toast({ toast, onDismiss }: ToastProps) {
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      className={clsx(
        'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-slate-200 border-l-4 bg-white p-3 shadow-lg animate-stream-in',
        KIND_BORDER[toast.kind],
      )}
      data-toast-kind={toast.kind}
    >
      <span
        className={clsx(
          'mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full',
          KIND_ICON_BG[toast.kind],
        )}
      >
        <KindIcon kind={toast.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-xs text-slate-500">{toast.description}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick()
              onDismiss(toast.id)
            }}
            className="mt-2 text-xs font-medium text-brand-600 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="ml-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
