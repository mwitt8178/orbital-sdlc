/**
 * PMThinkingIndicator — animated "PM is thinking" indicator row.
 *
 * Renders a PM avatar with three pulsing dots to indicate the PM persona
 * is composing a reply. Disappears when a PM message arrives.
 *
 * Shows an explanatory hint after 5 seconds of waiting so the user
 * understands the dev-mode stub behaviour.
 */

import { useState, useEffect, useRef } from 'react'

interface PMThinkingIndicatorProps {
  /** If true the hint about stub/real mode is shown after 5s. */
  showModeHint?: boolean
}

export function PMThinkingIndicator({ showModeHint = true }: PMThinkingIndicatorProps) {
  const [showHint, setShowHint] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!showModeHint) return
    timerRef.current = setTimeout(() => setShowHint(true), 5000)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [showModeHint])

  return (
    <li className="flex gap-2 animate-stream-in" aria-live="polite" aria-label="Product Manager is thinking">
      <div className="flex max-w-[80%] flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[9px] font-bold text-white">
            PM
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 px-3 py-2">
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
          </div>
        </div>
        {showHint && (
          <p className="ml-8 text-xs text-slate-400">
            If you connected an Anthropic key, the real PM persona is preparing. Otherwise,
            dev-mode stub will respond shortly.
          </p>
        )}
      </div>
    </li>
  )
}
