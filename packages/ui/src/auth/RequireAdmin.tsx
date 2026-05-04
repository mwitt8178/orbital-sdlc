/**
 * RequireAdmin — gates child routes behind both an authenticated session AND
 * a custom:role=admin claim.
 *
 * Non-admin authenticated users are redirected to /welcome with a 403-like
 * banner via location state. Unauthenticated users get the standard
 * RequireAuth redirect to /login.
 *
 * [Engineer-Principal · Opus · run-admin-integrations-split]
 */

import { type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.js'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAuthenticated, isHydrating, user } = useAuth()
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

  if (user?.role !== 'admin') {
    return <ForbiddenPage />
  }

  return <>{children}</>
}

function ForbiddenPage() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 px-6"
      data-testid="admin-forbidden"
    >
      <div className="max-w-md rounded-card-lg border border-slate-200 bg-white p-8 shadow-card">
        <p className="text-eyebrow font-semibold uppercase text-slate-500">403 — Forbidden</p>
        <h1 className="mt-2 text-display-md text-slate-900">Admin only</h1>
        <p className="mt-3 text-sm text-slate-600">
          The integrations page configures install-wide tools (Anthropic, Monday, GitHub) on behalf
          of every user in this install. Only an admin can change these.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          If you believe you should have access, ask the install owner to set your Cognito{' '}
          <code className="rounded bg-slate-100 px-1 text-xs">custom:role</code> attribute to{' '}
          <code className="rounded bg-slate-100 px-1 text-xs">admin</code>.
        </p>
        <a
          href="/welcome"
          className="mt-6 inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Back to Welcome
        </a>
      </div>
    </div>
  )
}
