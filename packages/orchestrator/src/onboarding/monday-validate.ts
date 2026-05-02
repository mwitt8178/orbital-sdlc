/**
 * monday-validate.ts — validate a Monday.com API token by querying `me { name }`.
 *
 * Uses native fetch (Node 18+) and a 5s timeout. The endpoint is
 * https://api.monday.com/v2 with the standard GraphQL POST body and an
 * Authorization header.
 *
 * Returns the account name on success; on failure, returns ok=false with a
 * friendly message extracted from Monday's error envelope.
 */

import type { ConnectMondayResult } from './types.js'

const MONDAY_ENDPOINT = 'https://api.monday.com/v2'
const VALIDATION_TIMEOUT_MS = 5_000

interface MondayMeResponse {
  data?: { me?: { name?: string; id?: string } | null }
  errors?: Array<{ message?: string; status_code?: number }>
  error_code?: string
  error_message?: string
}

export interface MondayValidator {
  validate(apiToken: string): Promise<ConnectMondayResult>
}

class DefaultMondayValidator implements MondayValidator {
  async validate(apiToken: string): Promise<ConnectMondayResult> {
    if (!apiToken || apiToken.trim().length === 0) {
      return { ok: false, message: 'API token is empty.' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)

    try {
      const res = await fetch(MONDAY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiToken,
          'API-Version': '2024-01',
        },
        body: JSON.stringify({ query: 'query { me { id name } }' }),
        signal: controller.signal,
      })

      const json = (await res.json().catch(() => null)) as MondayMeResponse | null

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: 'Invalid token — Monday rejected the credentials.' }
        }
        const upstream =
          (json && (json.error_message ?? json.errors?.[0]?.message)) ?? `HTTP ${res.status}`
        return { ok: false, message: `Monday API error: ${upstream}` }
      }

      if (json?.errors && json.errors.length > 0) {
        const msg = json.errors[0]?.message ?? 'Unknown Monday GraphQL error'
        return { ok: false, message: msg }
      }

      const name = json?.data?.me?.name
      if (!name) {
        return { ok: false, message: 'Monday returned no account info — token may be limited.' }
      }
      return { ok: true, accountName: name }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, message: 'Monday API call timed out after 5s.' }
      }
      if (err instanceof Error) {
        return { ok: false, message: err.message }
      }
      return { ok: false, message: String(err) }
    } finally {
      clearTimeout(timer)
    }
  }
}

let defaultInstance: MondayValidator | null = null

export function getMondayValidator(): MondayValidator {
  if (!defaultInstance) defaultInstance = new DefaultMondayValidator()
  return defaultInstance
}

/** Test-only override. */
export function setMondayValidator(v: MondayValidator | null): void {
  defaultInstance = v
}
