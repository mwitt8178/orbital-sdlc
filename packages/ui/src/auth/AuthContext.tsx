/**
 * AuthContext — single source of truth for the UI's auth session.
 *
 * Hydrates on mount from localStorage, then runs a periodic refresh check.
 * `getIdToken()` is the synchronous accessor used by tRPC's headers function;
 * it returns the cached token (or null). A background `useEffect` makes sure
 * the cached token is reasonably fresh.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  signInWithPassword,
  refreshTokens,
  decodeJwtPayload,
  type SessionTokens,
} from './cognito.js'
import { clearSession, loadSession, saveSession, type PersistedSession } from './storage.js'
// Wire WS auth accessor: the WebSocket client also needs the id token so the
// $connect Lambda accepts the handshake (?token=<jwt>).
// [Engineer-Principal · Opus · run-post-onboarding-100]
import { registerWsIdTokenAccessor } from '../services/ws.js'

interface AuthUser {
  email: string
  userId: string
  tenantId?: string
  role?: string
}

interface AuthContextValue {
  user: AuthUser | null
  isAuthenticated: boolean
  isHydrating: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  /** Synchronous read of the current id token. null if not signed in. */
  getIdToken: () => string | null
  /** Force a refresh now; returns true if it succeeded. */
  refresh: () => Promise<boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface IdClaims {
  sub: string
  email: string
  'custom:tenant_id'?: string
  tenant_id?: string
  'custom:role'?: string
}

function sessionFromTokens(email: string, tokens: SessionTokens): PersistedSession {
  const claims = decodeJwtPayload<IdClaims>(tokens.idToken) ?? ({} as IdClaims)
  return {
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    email: claims.email ?? email,
    userId: claims.sub ?? '',
    tenantId: claims['custom:tenant_id'] ?? claims.tenant_id,
    role: claims['custom:role'],
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PersistedSession | null>(null)
  const [isHydrating, setIsHydrating] = useState(true)
  // Hold the latest session in a ref so getIdToken() can read it without
  // re-rendering subscribers. tRPC reads this on every request.
  const sessionRef = useRef<PersistedSession | null>(null)

  const applySession = useCallback((next: PersistedSession | null) => {
    sessionRef.current = next
    setSession(next)
    if (next) saveSession(next)
    else clearSession()
  }, [])

  // Hydrate once on mount.
  useEffect(() => {
    const persisted = loadSession()
    if (persisted) {
      sessionRef.current = persisted
      setSession(persisted)
    }
    setIsHydrating(false)
  }, [])

  const refresh = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current
    if (!current) return false
    try {
      const tokens = await refreshTokens(current.email, current.refreshToken)
      applySession(sessionFromTokens(current.email, tokens))
      return true
    } catch {
      applySession(null)
      return false
    }
  }, [applySession])

  // Background refresh: if the token expires in less than 10 min, refresh now.
  useEffect(() => {
    if (!session) return undefined
    const tick = () => {
      const cur = sessionRef.current
      if (!cur) return
      const msLeft = cur.expiresAt - Date.now()
      if (msLeft < 10 * 60 * 1000) {
        void refresh()
      }
    }
    tick()
    const id = window.setInterval(tick, 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [session, refresh])

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { tokens } = await signInWithPassword(email, password)
      applySession(sessionFromTokens(email, tokens))
    },
    [applySession],
  )

  const signOut = useCallback(() => {
    applySession(null)
  }, [applySession])

  const getIdToken = useCallback((): string | null => {
    const cur = sessionRef.current
    if (!cur) return null
    if (cur.expiresAt <= Date.now()) return null
    return cur.idToken
  }, [])

  // Keep the getIdToken accessor available to non-React callers (tRPC client).
  // We expose it via a module-level setter below.
  useEffect(() => {
    setGlobalIdTokenAccessor(getIdToken)
    setGlobalSignOut(signOut)
    registerWsIdTokenAccessor(getIdToken)
    return () => {
      setGlobalIdTokenAccessor(() => null)
      setGlobalSignOut(() => undefined)
      registerWsIdTokenAccessor(() => null)
    }
  }, [getIdToken, signOut])

  const value = useMemo<AuthContextValue>(() => {
    const user: AuthUser | null = session
      ? {
          email: session.email,
          userId: session.userId,
          tenantId: session.tenantId,
          role: session.role,
        }
      : null
    return {
      user,
      isAuthenticated: !!session,
      isHydrating,
      signIn,
      signOut,
      getIdToken,
      refresh,
    }
  }, [session, isHydrating, signIn, signOut, getIdToken, refresh])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

// ---------------------------------------------------------------------------
// Module-level accessors for the tRPC client.
//
// The tRPC client is constructed once outside the React tree (in App.tsx),
// so it can't use useAuth(). We expose two function references that the
// AuthProvider wires up on mount and tears down on unmount. tRPC calls these
// inside its `headers()` callback for every request.
// ---------------------------------------------------------------------------

let _getIdToken: () => string | null = () => null
let _signOut: () => void = () => undefined

function setGlobalIdTokenAccessor(fn: () => string | null) {
  _getIdToken = fn
}
function setGlobalSignOut(fn: () => void) {
  _signOut = fn
}

export function authHeaders(): Record<string, string> {
  const token = _getIdToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function externalSignOut(): void {
  _signOut()
}
