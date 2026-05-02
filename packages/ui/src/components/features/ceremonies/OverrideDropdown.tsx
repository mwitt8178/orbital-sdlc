/**
 * OverrideDropdown — replaces the old "+ Schedule ceremony" primary button.
 *
 * Ceremonies fire automatically from event triggers. This dropdown is the
 * fallback / ad-hoc path for operators who need a ceremony outside normal
 * trigger conditions (e.g. "I want an architecture review right now").
 *
 * Options:
 *   - Architecture review (ad-hoc) → opens ScheduleCeremonyModal preset to 'custom'
 *   - Custom ceremony…             → opens ScheduleCeremonyModal with free selection
 */

import { useRef, useState, useEffect } from 'react'
import { Button } from '../../ui/Button.js'
import { ScheduleCeremonyModal } from './ScheduleCeremonyModal.js'

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

interface OverrideDropdownProps {
  /** Additional class names for the wrapper span. */
  className?: string
}

export function OverrideDropdown({ className }: OverrideDropdownProps) {
  const [open, setOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open])

  const handleOption = () => {
    setOpen(false)
    setModalOpen(true)
  }

  return (
    <span className={className}>
      <div className="relative inline-block">
        <Button
          ref={buttonRef}
          size="sm"
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Override — schedule ad-hoc ceremony"
        >
          Override
          <ChevronDownIcon className="h-3 w-3" />
        </Button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Override ceremony options"
            className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          >
            <button
              role="menuitem"
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              onClick={handleOption}
            >
              Architecture review (ad-hoc)
            </button>
            <button
              role="menuitem"
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              onClick={handleOption}
            >
              Custom ceremony…
            </button>
          </div>
        )}
      </div>

      <ScheduleCeremonyModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </span>
  )
}
