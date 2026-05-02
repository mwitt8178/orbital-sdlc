/**
 * MentionAutocomplete — popover that appears when the user types `@` in a
 * textarea. Filters the persona list in real time and inserts the selected
 * persona slug back into the parent's text state.
 *
 * Props:
 *   query       — the text after `@` (used to filter)
 *   anchorRef   — ref to the textarea so we can position the popover
 *   onSelect    — callback with the resolved persona slug to insert
 *   onDismiss   — called when user presses Escape or clicks away
 *
 * DEFERRED: personas.list tRPC procedure not in AppRouter.
 * Falls back to the hardcoded 11-persona list.
 */

import { useEffect, useRef } from 'react'

// Fallback 11-persona list used when no tRPC procedure exists.
const FALLBACK_PERSONAS = [
  'arch-lead',
  'backend-senior',
  'frontend-senior',
  'qa-lead',
  'product-manager',
  'tech-lead',
  'devops-engineer',
  'security-reviewer',
  'data-engineer',
  'ux-designer',
  'scrum-master',
]

interface MentionAutocompleteProps {
  query: string
  anchorRef: React.RefObject<HTMLTextAreaElement | null>
  onSelect: (slug: string) => void
  onDismiss: () => void
}

export function MentionAutocomplete({
  query,
  anchorRef,
  onSelect,
  onDismiss,
}: MentionAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const allPersonas = FALLBACK_PERSONAS

  const filtered = query
    ? allPersonas.filter((p) => p.toLowerCase().includes(query.toLowerCase()))
    : allPersonas.slice(0, 8)

  // Close on outside click.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        anchorRef.current !== (e.target as HTMLElement)
      ) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [anchorRef, onDismiss])

  // Close on Escape.
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onDismiss])

  if (filtered.length === 0) return null

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Mention suggestions"
      className="absolute z-30 mt-1 max-h-48 w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
    >
      {filtered.map((slug) => (
        <button
          key={slug}
          role="option"
          aria-selected={false}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 focus:bg-indigo-50 focus:outline-none"
          onMouseDown={(e) => {
            // Prevent textarea blur before the click fires.
            e.preventDefault()
            onSelect(slug)
          }}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[9px] font-bold text-indigo-700">
            {slug.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate">@{slug}</span>
        </button>
      ))}
    </div>
  )
}
