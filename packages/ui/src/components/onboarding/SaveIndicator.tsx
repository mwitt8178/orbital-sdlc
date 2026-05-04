/**
 * SaveIndicator — small status pill that reflects autosave state in the
 * onboarding shell footer.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { AnimatePresence, motion } from 'framer-motion'
import { DURATION, EASE } from './motion.js'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface Props {
  state: SaveState
  errorMessage?: string | null
}

const COPY: Record<SaveState, string> = {
  idle: 'Auto-saving on every step',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
}

export function SaveIndicator({ state, errorMessage }: Props) {
  const tone =
    state === 'error'
      ? 'text-red-700 bg-red-50 border-red-200'
      : state === 'saved'
        ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
        : state === 'saving'
          ? 'text-brand-700 bg-brand-50 border-brand-200'
          : 'text-slate-500 bg-slate-50 border-slate-200'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={state}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: DURATION.fast, ease: EASE.out }}
          className="inline-flex items-center gap-1.5"
        >
          <Dot state={state} />
          <span>{state === 'error' && errorMessage ? errorMessage : COPY[state]}</span>
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function Dot({ state }: { state: SaveState }) {
  if (state === 'saving') {
    return (
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500" />
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (state === 'error') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    )
  }
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400" />
}
