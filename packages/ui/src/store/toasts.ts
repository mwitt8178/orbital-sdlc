/**
 * toasts.ts — Zustand store for the global toast system.
 *
 * The store keeps a flat list of active toasts. The `<ToastProvider>` reads
 * this store and renders the visible cards; auto-dismiss timers are owned by
 * the provider, NOT by the store, so the store stays a pure data container.
 *
 * Stacking rules (per design):
 *   - Up to 5 toasts visible at once.
 *   - When a 6th is pushed, the oldest is removed and a "+N more" pill is
 *     inferred at render time from `excessCount`.
 *
 * Dedupe: callers may pass an optional `dedupeKey`. If a toast with the same
 * key is already on screen, the existing entry is updated in place
 * (timestamp refreshed) instead of stacking another card.
 */

import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'warn' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  description?: string
  durationMs: number
  action?: ToastAction
  dedupeKey?: string
  /** Wall-clock millis when the toast was pushed; used for sort stability. */
  createdAt: number
}

export interface ToastInput {
  kind: ToastKind
  title: string
  description?: string
  /** 0 = sticky (manual dismiss only). Default 5000. */
  durationMs?: number
  action?: ToastAction
  dedupeKey?: string
}

interface ToastsState {
  toasts: Toast[]
  /** Number of toasts dropped from the visible stack (for "+N more" pill). */
  excessCount: number
  push: (input: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
}

const MAX_VISIBLE = 5
const DEFAULT_DURATION_MS = 5000

let _idCounter = 0
function generateId(): string {
  _idCounter += 1
  return `toast-${String(Date.now())}-${String(_idCounter)}`
}

export const useToastsStore = create<ToastsState>((set) => ({
  toasts: [],
  excessCount: 0,
  push: (input) => {
    const id = generateId()
    const next: Toast = {
      id,
      kind: input.kind,
      title: input.title,
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
      createdAt: Date.now(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    }

    set((state) => {
      // Dedupe: if a toast with the same key exists, refresh it in place.
      if (next.dedupeKey !== undefined) {
        const existingIndex = state.toasts.findIndex(
          (t) => t.dedupeKey === next.dedupeKey,
        )
        if (existingIndex >= 0) {
          const replacedList = state.toasts.slice()
          const existing = replacedList[existingIndex]
          if (!existing) return state
          replacedList[existingIndex] = {
            ...existing,
            ...next,
            id: existing.id,
            createdAt: Date.now(),
          }
          return { toasts: replacedList, excessCount: state.excessCount }
        }
      }

      const list = [...state.toasts, next]
      if (list.length <= MAX_VISIBLE) {
        return { toasts: list, excessCount: state.excessCount }
      }
      // Drop the oldest non-action card to make room. Action toasts are
      // sticky-ish: never auto-evict them. If only action toasts exist, evict
      // the absolute oldest as a fallback.
      const overflow = list.length - MAX_VISIBLE
      const trimmed = list.slice()
      let removed = 0
      for (let i = 0; i < trimmed.length && removed < overflow; ) {
        const t = trimmed[i]
        if (t && t.action === undefined) {
          trimmed.splice(i, 1)
          removed++
          continue
        }
        i++
      }
      while (removed < overflow && trimmed.length > MAX_VISIBLE) {
        trimmed.shift()
        removed++
      }
      return {
        toasts: trimmed,
        excessCount: state.excessCount + removed,
      }
    })
    return id
  },
  dismiss: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
      excessCount: state.excessCount,
    })),
  clear: () => set({ toasts: [], excessCount: 0 }),
}))

export const __test = {
  MAX_VISIBLE,
  DEFAULT_DURATION_MS,
}
