/**
 * admin-context.ts — In-memory admin token store + React context.
 *
 * The admin token is held in plain memory only — never localStorage,
 * never sessionStorage. A page reload requires re-entry. This is
 * deliberately conservative for an operations surface that can rotate
 * keys and wipe the install.
 */

import { createContext, useContext } from 'react'

export interface AdminTokenContextShape {
  token: string | null
  setToken: (token: string | null) => void
}

export const AdminTokenContext = createContext<AdminTokenContextShape>({
  token: null,
  setToken: () => undefined,
})

export function useAdminToken(): AdminTokenContextShape {
  return useContext(AdminTokenContext)
}
