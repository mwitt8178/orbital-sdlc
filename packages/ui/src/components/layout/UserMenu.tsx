/**
 * UserMenu — replaces the static "MW" avatar in the TopBar with a real
 * dropdown that shows the signed-in user and exposes Sign out.
 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'

function initialsFor(email: string): string {
  if (!email) return '?'
  const local = email.split('@')[0] ?? email
  const parts = local.split(/[._-]/).filter(Boolean)
  const a = parts[0]
  const b = parts[1]
  if (a && b && a[0] && b[0]) {
    return (a[0] + b[0]).toUpperCase()
  }
  return local.slice(0, 2).toUpperCase()
}

export function UserMenu() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!user) return null
  const initials = initialsFor(user.email)

  const handleSignOut = () => {
    signOut()
    setOpen(false)
    navigate('/login', { replace: true })
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Account menu for ${user.email}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        data-testid="user-menu-trigger"
      >
        {initials}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 w-56 overflow-hidden rounded-md border border-slate-200 bg-white shadow-card"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="truncate text-sm font-medium text-slate-900">{user.email}</p>
            {user.role && <p className="text-xs text-slate-500">{user.role}</p>}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
            data-testid="user-menu-signout"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
