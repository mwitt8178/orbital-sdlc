/**
 * onboarding/github-validate.ts — validate a Github personal access token by
 * calling GET /user.
 *
 * Mirror of monday-validate.ts. Returns { ok, message?, login? }.
 *
 * Used by ProjectsService.connectGithub() and the onboarding wizard step.
 */

import type { ValidateGithubResult } from '../github/types.js'

const GITHUB_USER_ENDPOINT = 'https://api.github.com/user'
const VALIDATION_TIMEOUT_MS = 5_000

export interface GithubValidator {
  validate(token: string): Promise<ValidateGithubResult>
}

export async function validateGithubToken(token: string): Promise<ValidateGithubResult> {
  if (!token || token.trim().length === 0) {
    return { ok: false, message: 'API token is empty.' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)

  try {
    const res = await fetch(GITHUB_USER_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'orbital-orchestrator',
      },
      signal: controller.signal,
    })

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Invalid token — Github rejected the credentials.' }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        message: `Github API error: HTTP ${res.status} ${text || ''}`.trim(),
      }
    }

    const json = (await res.json().catch(() => null)) as { login?: string } | null
    if (!json?.login) {
      return { ok: false, message: 'Github returned no login — token may be limited.' }
    }
    return { ok: true, login: json.login }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'Github API call timed out after 5s.' }
    }
    if (err instanceof Error) {
      return { ok: false, message: err.message }
    }
    return { ok: false, message: String(err) }
  } finally {
    clearTimeout(timer)
  }
}

class DefaultGithubValidator implements GithubValidator {
  validate(token: string): Promise<ValidateGithubResult> {
    return validateGithubToken(token)
  }
}

let defaultInstance: GithubValidator | null = null

export function getGithubValidator(): GithubValidator {
  if (!defaultInstance) defaultInstance = new DefaultGithubValidator()
  return defaultInstance
}

/** Test-only override. */
export function setGithubValidator(v: GithubValidator | null): void {
  defaultInstance = v
}
