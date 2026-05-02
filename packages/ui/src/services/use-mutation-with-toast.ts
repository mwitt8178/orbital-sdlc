/**
 * use-mutation-with-toast.ts — wraps a tRPC mutation hook so common UX
 * affordances (success/error toasts) are dispatched without per-call wiring.
 *
 * Usage:
 *
 *   const mutation = trpc.audit.export.request.useMutation()
 *   const { mutate, isPending } = useMutationWithToast(mutation, {
 *     successMsg: 'Export queued',
 *     errorMsg: 'Could not request export',
 *   })
 *
 * The wrapper preserves the original mutation API (`mutate`, `mutateAsync`,
 * `isPending`, `error`, `data`, `reset`). It does NOT swallow errors — the
 * caller can still observe `mutation.error` and trigger their own UI.
 */

import { useEffect, useRef } from 'react'
import { useToast } from './use-toast.js'

interface MutationLike<TData, TError, TInput> {
  mutate: (input: TInput) => void
  mutateAsync: (input: TInput) => Promise<TData>
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  data: TData | undefined
  error: TError | null
  reset: () => void
}

interface ToastOptions<TData, TError> {
  successMsg?: string | ((data: TData) => string)
  errorMsg?: string | ((err: TError) => string)
  successDescription?: string | ((data: TData) => string)
  errorDescription?: string | ((err: TError) => string)
  /** Toast deduplication key; lets consecutive identical toasts collapse. */
  dedupeKey?: string
}

function resolveString<T>(
  value: string | ((arg: T) => string) | undefined,
  arg: T,
): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'function' ? value(arg) : value
}

export function useMutationWithToast<TData, TError extends { message?: string }, TInput>(
  mutation: MutationLike<TData, TError, TInput>,
  options: ToastOptions<TData, TError> = {},
): MutationLike<TData, TError, TInput> {
  const toast = useToast()
  const lastSuccessRef = useRef<TData | undefined>(undefined)
  const lastErrorRef = useRef<TError | null>(null)

  useEffect(() => {
    if (!mutation.isSuccess) return
    if (mutation.data === lastSuccessRef.current) return
    lastSuccessRef.current = mutation.data
    if (mutation.data === undefined) return
    const title = resolveString(options.successMsg, mutation.data)
    if (title === undefined) return
    const description = resolveString(options.successDescription, mutation.data)
    toast.success(title, {
      ...(description !== undefined ? { description } : {}),
      ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    })
  }, [mutation.isSuccess, mutation.data, options, toast])

  useEffect(() => {
    if (!mutation.isError) return
    if (mutation.error === lastErrorRef.current) return
    lastErrorRef.current = mutation.error
    if (mutation.error === null) return
    const fallback = mutation.error.message ?? 'Request failed'
    const title =
      resolveString(options.errorMsg, mutation.error) ?? fallback
    const description = resolveString(options.errorDescription, mutation.error)
    toast.error(title, {
      ...(description !== undefined ? { description } : {}),
      ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    })
  }, [mutation.isError, mutation.error, options, toast])

  return mutation
}
