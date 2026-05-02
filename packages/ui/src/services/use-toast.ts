/**
 * use-toast.ts — Public hook for dispatching toasts.
 *
 * Returns the four severity methods. Each accepts a title and optional
 * description / action / durationMs / dedupeKey. The hook is a thin wrapper
 * around the Zustand store; consumers do not need to import the store
 * directly.
 *
 * Stable identity: the returned object is memoised so passing it as a
 * useEffect dep does not cause re-runs.
 */

import { useMemo } from 'react'
import { useToastsStore, type ToastInput } from '../store/toasts.js'

interface ToastOptions {
  description?: string
  durationMs?: number
  action?: { label: string; onClick: () => void }
  dedupeKey?: string
}

export interface ToastApi {
  success: (title: string, opts?: ToastOptions) => string
  error: (title: string, opts?: ToastOptions) => string
  warn: (title: string, opts?: ToastOptions) => string
  info: (title: string, opts?: ToastOptions) => string
  dismiss: (id: string) => void
  clear: () => void
}

function buildInput(
  kind: ToastInput['kind'],
  title: string,
  opts?: ToastOptions,
): ToastInput {
  return {
    kind,
    title,
    ...(opts?.description !== undefined ? { description: opts.description } : {}),
    ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts?.action !== undefined ? { action: opts.action } : {}),
    ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
  }
}

export function useToast(): ToastApi {
  const push = useToastsStore((s) => s.push)
  const dismiss = useToastsStore((s) => s.dismiss)
  const clear = useToastsStore((s) => s.clear)

  return useMemo<ToastApi>(
    () => ({
      success: (title, opts) => push(buildInput('success', title, opts)),
      error: (title, opts) => push(buildInput('error', title, opts)),
      warn: (title, opts) => push(buildInput('warn', title, opts)),
      info: (title, opts) => push(buildInput('info', title, opts)),
      dismiss,
      clear,
    }),
    [push, dismiss, clear],
  )
}
