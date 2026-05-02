/**
 * ToastProvider.tsx — fixed-position container for active toasts.
 *
 * Mounts at the App root. Reads visible toasts from the Zustand store and
 * renders them top-right. Owns the per-toast auto-dismiss timer (via a single
 * effect that reconciles timers on each store update).
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useToastsStore } from '../../store/toasts.js'
import { Toast } from './Toast.js'

export function ToastProvider() {
  const toasts = useToastsStore((s) => s.toasts)
  const excessCount = useToastsStore((s) => s.excessCount)
  const dismiss = useToastsStore((s) => s.dismiss)
  const clear = useToastsStore((s) => s.clear)

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const timers = timersRef.current
    const visibleIds = new Set(toasts.map((t) => t.id))

    // Clear timers for toasts no longer visible.
    for (const [id, timer] of timers.entries()) {
      if (!visibleIds.has(id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }

    // Schedule timers for any new toasts that have a duration.
    for (const t of toasts) {
      if (t.durationMs <= 0) continue
      if (timers.has(t.id)) continue
      const timer = setTimeout(() => {
        dismiss(t.id)
        timers.delete(t.id)
      }, t.durationMs)
      timers.set(t.id, timer)
    }
  }, [toasts, dismiss])

  // Cleanup on unmount.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  if (typeof document === 'undefined') return null

  const node = (
    <div
      aria-label="Notifications"
      role="region"
      className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismiss} />
      ))}
      {excessCount > 0 ? (
        <button
          type="button"
          onClick={clear}
          className="pointer-events-auto self-end rounded-full bg-slate-900/90 px-3 py-1 text-[11px] font-medium text-white shadow-lg hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          +{excessCount} more · clear
        </button>
      ) : null}
    </div>
  )

  return createPortal(node, document.body)
}
