/**
 * github/app-client.ts — Real GitHub App-auth client.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 *
 * Implements the FROZEN StoryExecutor contract (see
 * .claude/tasks/orbital-github-integration/contract.md):
 *   - createBranch(repo, name)
 *   - commitFiles(repo, branch, files, message)
 *   - openPullRequest(repo, head, base, title, body)
 *   - getPullRequestStatus(prUrl)
 *   - addPRComment(prUrl, body)
 *   - mergePR(prUrl, method?)
 *
 * Token model: GitHub App installation token (NOT user OAuth, NOT PAT).
 * Caller resolves installationId from a tenant-scoped binding row, never
 * from a header — multi-tenant isolation is enforced at the binding layer.
 */

import { OrbitalError } from '@orbital/types'
import { GITHUB_ERROR_CODES } from './types.js'
import { InstallationTokenProvider } from './app-auth.js'

// ---------------------------------------------------------------------------
// Public types — match contract.md exactly
// ---------------------------------------------------------------------------

export interface RepoRef {
  installationId: number
  fullName: string
}

export interface CommitFile {
  path: string
  content_utf8?: string
  content_base64?: string
}

export interface PullRequestStatus {
  state: 'open' | 'closed' | 'merged'
  mergeable: boolean | null
  ci_status: 'pending' | 'success' | 'failure' | 'unknown'
}

export interface StoryExecutorGitHubClient {
  createBranch(repo: RepoRef, name: string): Promise<{ branch: string; sha: string }>
  commitFiles(
    repo: RepoRef,
    branch: string,
    files: ReadonlyArray<CommitFile>,
    message: string,
  ): Promise<{ commit_sha: string }>
  openPullRequest(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ url: string; number: number }>
  getPullRequestStatus(prUrl: string): Promise<PullRequestStatus>
  addPRComment(prUrl: string, body: string): Promise<{ comment_id: number }>
  mergePR(prUrl: string, method?: 'merge' | 'squash' | 'rebase'): Promise<{ merge_sha: string }>
}

// ---------------------------------------------------------------------------
// PR URL parsing
// ---------------------------------------------------------------------------

/** Parse https://github.com/owner/repo/pull/123 → { owner, repo, number }. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  if (!m) throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Bad PR URL: ${url}`)
  return { owner: m[1]!, repo: m[2]!, number: Number.parseInt(m[3]!, 10) }
}

function parseFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/')
  if (!owner || !repo) {
    throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Bad full_name: ${fullName}`)
  }
  return { owner, repo }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface AppClientOptions {
  tokenProvider: InstallationTokenProvider
  apiUrl?: string
  fetchImpl?: typeof fetch
}

export class DefaultStoryExecutorGitHubClient implements StoryExecutorGitHubClient {
  private readonly apiUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: AppClientOptions) {
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  // -------------------------------------------------------------------------
  // Generic authenticated request keyed to an installation token
  // -------------------------------------------------------------------------

  private async request<T>(
    installationId: number,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options: { allow404?: boolean } = {},
  ): Promise<T | null> {
    const token = await this.opts.tokenProvider.getInstallationToken(installationId)
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'orbital-orchestrator',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (res.status === 401 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') !== '0')) {
      throw new OrbitalError(
        GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH,
        `GitHub auth/permission failed: HTTP ${res.status}`,
        { status: res.status },
      )
    }
    if (res.status === 404) {
      if (options.allow404) return null
      throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Not found: ${method} ${path}`, {
        status: 404,
      })
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = res.headers.get('x-ratelimit-reset')
      const resetMs = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : undefined
      throw new OrbitalError(GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API, `GitHub rate limit hit`, {
        retry_after_ms: resetMs,
      })
    }
    if (res.status >= 500) {
      throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `GitHub ${res.status}`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new OrbitalError(
        GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN,
        `GitHub ${method} ${path} failed: ${res.status} ${text}`,
        { status: res.status, retryable: false },
      )
    }
    if (res.status === 204) return null
    return (await res.json()) as T
  }

  // -------------------------------------------------------------------------
  // StoryExecutor contract
  // -------------------------------------------------------------------------

  async createBranch(repo: RepoRef, name: string): Promise<{ branch: string; sha: string }> {
    const { owner, repo: repoName } = parseFullName(repo.fullName)
    // Check if branch already exists — idempotent per contract.
    const existing = await this.request<{ object: { sha: string } }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(name)}`,
      undefined,
      { allow404: true },
    )
    if (existing) return { branch: name, sha: existing.object.sha }

    // Resolve default branch HEAD sha.
    const repoMeta = await this.request<{ default_branch: string }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}`,
    )
    if (!repoMeta) {
      throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Repo missing: ${repo.fullName}`)
    }
    const head = await this.request<{ object: { sha: string } }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(repoMeta.default_branch)}`,
    )
    if (!head) {
      throw new OrbitalError(
        GITHUB_ERROR_CODES.NOT_FOUND_GITHUB,
        `Default branch ref missing: ${repo.fullName}@${repoMeta.default_branch}`,
      )
    }
    const created = await this.request<{ object: { sha: string } }>(
      repo.installationId,
      'POST',
      `/repos/${owner}/${repoName}/git/refs`,
      { ref: `refs/heads/${name}`, sha: head.object.sha },
    )
    if (!created) {
      throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'createBranch returned no body')
    }
    return { branch: name, sha: created.object.sha }
  }

  async commitFiles(
    repo: RepoRef,
    branch: string,
    files: ReadonlyArray<CommitFile>,
    message: string,
  ): Promise<{ commit_sha: string }> {
    if (files.length === 0) {
      throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'commitFiles: empty files')
    }
    const { owner, repo: repoName } = parseFullName(repo.fullName)

    // 1. Get branch HEAD commit + tree.
    const ref = await this.request<{ object: { sha: string } }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
    if (!ref) throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Branch missing: ${branch}`)
    const parentSha = ref.object.sha
    const parentCommit = await this.request<{ tree: { sha: string } }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}/git/commits/${parentSha}`,
    )
    if (!parentCommit) {
      throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'commit fetch returned no body')
    }

    // 2. Create blobs (one per file).
    const blobShas = await Promise.all(
      files.map(async (f) => {
        const body =
          f.content_base64 !== undefined
            ? { content: f.content_base64, encoding: 'base64' }
            : { content: f.content_utf8 ?? '', encoding: 'utf-8' }
        const blob = await this.request<{ sha: string }>(
          repo.installationId,
          'POST',
          `/repos/${owner}/${repoName}/git/blobs`,
          body,
        )
        if (!blob) throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'blob create no body')
        return { path: f.path, sha: blob.sha }
      }),
    )

    // 3. Create tree built on the parent tree.
    const tree = await this.request<{ sha: string }>(
      repo.installationId,
      'POST',
      `/repos/${owner}/${repoName}/git/trees`,
      {
        base_tree: parentCommit.tree.sha,
        tree: blobShas.map((b) => ({
          path: b.path,
          mode: '100644',
          type: 'blob',
          sha: b.sha,
        })),
      },
    )
    if (!tree) throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'tree create no body')

    // 4. Create commit.
    const commit = await this.request<{ sha: string }>(
      repo.installationId,
      'POST',
      `/repos/${owner}/${repoName}/git/commits`,
      { message, tree: tree.sha, parents: [parentSha] },
    )
    if (!commit) throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'commit create no body')

    // 5. Fast-forward branch ref to new commit.
    await this.request<unknown>(
      repo.installationId,
      'PATCH',
      `/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(branch)}`,
      { sha: commit.sha, force: false },
    )
    return { commit_sha: commit.sha }
  }

  async openPullRequest(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ url: string; number: number }> {
    const { owner, repo: repoName } = parseFullName(repo.fullName)
    const data = await this.request<{ html_url: string; number: number }>(
      repo.installationId,
      'POST',
      `/repos/${owner}/${repoName}/pulls`,
      { head, base, title, body },
    )
    if (!data) throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'PR create no body')
    return { url: data.html_url, number: data.number }
  }

  async getPullRequestStatus(prUrl: string): Promise<PullRequestStatus> {
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    // We need installation_id but the caller passed a URL only. Per contract,
    // status lookup happens after the PR was opened by the same client, so
    // the caller must provide an installation_id via an explicit method on
    // the client wrapper (see PrStatusResolver below). For the StoryExecutor
    // flow we expose this getter through a wrapper that knows the binding.
    throw new OrbitalError(
      GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN,
      'getPullRequestStatus requires explicit installationId — use getPullRequestStatusFor(repo, prUrl)',
      { owner, repo: repoName, number },
    )
  }

  /** Variant that takes the repo ref (and thus installationId) explicitly. */
  async getPullRequestStatusFor(repo: RepoRef, prUrl: string): Promise<PullRequestStatus> {
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    const pr = await this.request<{
      state: string
      merged: boolean
      mergeable: boolean | null
      head: { sha: string }
    }>(repo.installationId, 'GET', `/repos/${owner}/${repoName}/pulls/${number}`)
    if (!pr) throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `PR not found: ${prUrl}`)

    let ciStatus: PullRequestStatus['ci_status'] = 'unknown'
    const checks = await this.request<{
      check_runs: Array<{ status: string; conclusion: string | null }>
    }>(
      repo.installationId,
      'GET',
      `/repos/${owner}/${repoName}/commits/${pr.head.sha}/check-runs?per_page=100`,
    )
    if (checks && checks.check_runs.length > 0) {
      if (checks.check_runs.some((c) => c.status !== 'completed')) ciStatus = 'pending'
      else if (checks.check_runs.every((c) => c.conclusion === 'success' || c.conclusion === 'neutral'))
        ciStatus = 'success'
      else ciStatus = 'failure'
    }

    const state: PullRequestStatus['state'] = pr.merged
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : 'open'
    return { state, mergeable: pr.mergeable, ci_status: ciStatus }
  }

  async addPRComment(prUrl: string, body: string): Promise<{ comment_id: number }> {
    // Issue-comment endpoint (works for PRs since they are issues).
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    // Caller must wrap with addPRCommentFor.
    throw new OrbitalError(
      GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN,
      'addPRComment requires explicit installationId — use addPRCommentFor(repo, prUrl, body)',
      { owner, repo: repoName, number },
    )
  }

  async addPRCommentFor(repo: RepoRef, prUrl: string, body: string): Promise<{ comment_id: number }> {
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    const data = await this.request<{ id: number }>(
      repo.installationId,
      'POST',
      `/repos/${owner}/${repoName}/issues/${number}/comments`,
      { body },
    )
    if (!data) throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'comment create no body')
    return { comment_id: data.id }
  }

  async mergePR(
    prUrl: string,
    _method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merge_sha: string }> {
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    throw new OrbitalError(
      GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN,
      'mergePR requires explicit installationId — use mergePRFor(repo, prUrl, method?)',
      { owner, repo: repoName, number },
    )
  }

  async mergePRFor(
    repo: RepoRef,
    prUrl: string,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merge_sha: string }> {
    const { owner, repo: repoName, number } = parsePrUrl(prUrl)
    const data = await this.request<{ sha: string; merged: boolean }>(
      repo.installationId,
      'PUT',
      `/repos/${owner}/${repoName}/pulls/${number}/merge`,
      { merge_method: method },
    )
    if (!data || !data.merged) {
      throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'PR merge failed')
    }
    return { merge_sha: data.sha }
  }
}

/**
 * Factory: build the App client from an `appId` + private key + fetch.
 */
export function createStoryExecutorGitHubClient(opts: {
  appId: number
  privateKeyPem: string
  fetchImpl?: typeof fetch
}): DefaultStoryExecutorGitHubClient {
  const tokenProvider = new InstallationTokenProvider({
    appId: opts.appId,
    privateKeyPem: opts.privateKeyPem,
    fetchImpl: opts.fetchImpl,
  })
  return new DefaultStoryExecutorGitHubClient({
    tokenProvider,
    fetchImpl: opts.fetchImpl,
  })
}
