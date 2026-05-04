/**
 * Auth session storage — localStorage with safe parse + version key.
 *
 * Bumping STORAGE_KEY (v1 -> v2) silently invalidates all existing sessions.
 * That's the rollback plan if the schema ever needs to change.
 */

const STORAGE_KEY = 'orbital.auth.v1'

export interface PersistedSession {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
  email: string
  userId: string
  tenantId?: string
  role?: string
}

export function loadSession(): PersistedSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedSession
    if (
      typeof parsed.idToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveSession(session: PersistedSession): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}
