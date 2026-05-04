/**
 * RequireAuth — gates child routes behind an authenticated session.
 *
 * Hydration semantics: while the AuthProvider is reading localStorage, we
 * render nothing (a brief flash) rather than redirecting prematurely.
 */

import { type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.js'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isHydrating } = useAuth()
  const location = useLocation()

  if (isHydrating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-sm text-slate-500" role="status">
          <span
            className="h-2 w-2 animate-pulse-dot rounded-full bg-brand-500"
            aria-hidden="true"
          />
          Loading…
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}
