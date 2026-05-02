/**
 * github/types.ts — Github integration types + error codes.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Error codes mirror MondayClient (INTEGRATION_GITHUB_DOWN /
 * INTEGRATION_GITHUB_AUTH / RATE_LIMIT_GITHUB_API / STARTUP_ERROR) so the UI
 * can render consistent integration banners.
 */

export const GITHUB_ERROR_CODES = {
  /** Github 5xx / network failure. Retryable with backoff. */
  INTEGRATION_GITHUB_DOWN: 'INTEGRATION_GITHUB_DOWN',
  /** Github 401 / 403 with auth issue (token invalid or scopes missing). */
  INTEGRATION_GITHUB_AUTH: 'INTEGRATION_GITHUB_AUTH',
  /** Github primary or secondary rate limit hit. */
  RATE_LIMIT_GITHUB_API: 'RATE_LIMIT_GITHUB_API',
  /** Token missing entirely; surface to user. */
  STARTUP_ERROR: 'STARTUP_ERROR',
  /** 404 from the Github API — repo / branch / user not found. */
  NOT_FOUND_GITHUB: 'NOT_FOUND_GITHUB',
  /** Validation error on input. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const

export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[keyof typeof GITHUB_ERROR_CODES]

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GithubRepo {
  id: number
  name: string
  fullName: string
  owner: { login: string }
  private: boolean
  defaultBranch: string
  htmlUrl: string
}

export interface GithubBranch {
  name: string
  commitSha: string
  protected: boolean
}

export interface CreateRepoParams {
  /** Owner login. If owner is the authenticated user, omit; else org name. */
  org?: string
  name: string
  private?: boolean
  description?: string
  defaultBranch?: string
}

export interface ValidateGithubResult {
  ok: boolean
  message?: string
  /** Authenticated user login on success. */
  login?: string
}

// ---------------------------------------------------------------------------
// Pull-request types
// ---------------------------------------------------------------------------

export type PullRequestState = 'open' | 'closed' | 'merged'

export interface GithubPullRequest {
  pr_number: number
  html_url: string
  state: PullRequestState
  merged: boolean
  merged_at: string | null
  title: string
  body: string | null
  head: string
  base: string
  labels: string[]
}

export interface CreatePullRequestParams {
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
}

export interface AddLabelsParams {
  owner: string
  repo: string
  pr_number: number
  labels: string[]
}

export interface MergePullRequestParams {
  owner: string
  repo: string
  pr_number: number
  mergeMethod: 'merge' | 'squash' | 'rebase'
}

export interface ListPRsByLabelParams {
  owner: string
  repo: string
  label: string
}

export interface GetPullRequestParams {
  owner: string
  repo: string
  pr_number: number
}
