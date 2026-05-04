/**
 * github/install-repos.ts — Repo list fetching for GitHub App installations.
 *
 * [Engineer-Sr · Sonnet · run-github-app-install]
 *
 * Provides:
 *   - `GitHubRepo`       — shape of a repo from GET /installation/repositories
 *   - `RepoListCache`    — 60s in-process TTL cache keyed by installation_id
 *   - `listInstallationRepos` — paginated fetch from GitHub API with caching
 *   - `assertInstallationBelongsToTenant` — tenant isolation guard
 *
 * Multi-tenant posture:
 *   Every caller must verify that the requested installation_id belongs to the
 *   caller's tenant before calling listInstallationRepos. The check is done via
 *   `assertInstallationBelongsToTenant`, which receives a `queryInstallations`
 *   function so the guard is DB-agnostic and testable without a real DB.
 *
 * Token posture:
 *   The installation token is obtained via `getToken` (a thunk). The caller
 *   (tRPC router) wires this to `InstallationTokenProvider.getInstallationToken`.
 *   Installation tokens are never persisted; they are in-process only.
 */

import { TRPCError } from '@trpc/server'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  id: number
  fullName: string
  defaultBranch: string
  private: boolean
}

interface CachedEntry {
  repos: GitHubRepo[]
  expiresAtMs: number
}

// ---------------------------------------------------------------------------
// RepoListCache — process-local TTL cache keyed by installation_id
// ---------------------------------------------------------------------------

export interface RepoListCacheOptions {
  /** TTL in ms. Default: 60_000 (60 seconds). */
  ttlMs?: number
  /** Clock fn for testability. */
  nowMs?: () => number
}

export class RepoListCache {
  private readonly store = new Map<number, CachedEntry>()
  private readonly ttlMs: number
  private readonly nowMs: () => number

  constructor(opts: RepoListCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000
    this.nowMs = opts.nowMs ?? (() => Date.now())
  }

  get(installationId: number): GitHubRepo[] | null {
    const entry = this.store.get(installationId)
    if (!entry) return null
    if (this.nowMs() > entry.expiresAtMs) {
      this.store.delete(installationId)
      return null
    }
    return entry.repos
  }

  set(installationId: number, repos: GitHubRepo[]): void {
    this.store.set(installationId, {
      repos,
      expiresAtMs: this.nowMs() + this.ttlMs,
    })
  }

  invalidate(installationId: number): void {
    this.store.delete(installationId)
  }
}

// ---------------------------------------------------------------------------
// Process-level default cache singleton
// ---------------------------------------------------------------------------

let _defaultCache: RepoListCache | null = null

export function getDefaultRepoListCache(): RepoListCache {
  if (!_defaultCache) {
    _defaultCache = new RepoListCache({ ttlMs: 60_000 })
  }
  return _defaultCache
}

// ---------------------------------------------------------------------------
// listInstallationRepos
// ---------------------------------------------------------------------------

export interface ListInstallationReposOptions {
  installationId: number
  /** Returns a valid installation token (may be cached). */
  getToken: () => Promise<string>
  /** Cache instance. Defaults to process-level singleton. */
  cache?: RepoListCache
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** GitHub API base URL (default: https://api.github.com). */
  apiUrl?: string
}

/**
 * Fetch all repositories accessible to the given installation. Paginates
 * through all pages and caches the result for 60 seconds.
 *
 * On cache hit, returns cached repos without hitting GitHub.
 */
export async function listInstallationRepos(opts: ListInstallationReposOptions): Promise<GitHubRepo[]> {
  const cache = opts.cache ?? getDefaultRepoListCache()
  const hit = cache.get(opts.installationId)
  if (hit) return hit

  const token = await opts.getToken()
  const apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  const allRepos: GitHubRepo[] = []
  let page = 1
  let totalCount: number | null = null

  while (true) {
    const url = `${apiUrl}/installation/repositories?per_page=100&page=${page}`
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `token ${token}`,
        'User-Agent': 'orbital-orchestrator',
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub installation repos fetch failed: ${res.status} ${text}`)
    }

    const json = (await res.json()) as {
      repositories: Array<{
        id: number
        full_name: string
        default_branch: string
        private: boolean
      }>
      total_count: number
    }

    if (totalCount === null) {
      totalCount = json.total_count
    }

    for (const r of json.repositories) {
      allRepos.push({
        id: r.id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      })
    }

    if (allRepos.length >= totalCount || json.repositories.length === 0) {
      break
    }
    page++
  }

  cache.set(opts.installationId, allRepos)
  return allRepos
}

// ---------------------------------------------------------------------------
// assertInstallationBelongsToTenant — tenant isolation guard
// ---------------------------------------------------------------------------

export interface AssertInstallationOptions {
  installationId: number
  tenantId: string
  /** Returns rows from github_installations scoped to tenant. */
  queryInstallations: (params: {
    installationId: number
    tenantId: string
  }) => Promise<Array<{ installationId: number }>>
}

/**
 * Asserts that the given installation_id is owned by the given tenant.
 * Throws TRPCError FORBIDDEN if not.
 *
 * This is the primary multi-tenant isolation guard for all github.listRepos
 * and github.getInstallationToken calls.
 */
export async function assertInstallationBelongsToTenant(
  opts: AssertInstallationOptions,
): Promise<void> {
  const rows = await opts.queryInstallations({
    installationId: opts.installationId,
    tenantId: opts.tenantId,
  })

  if (rows.length === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `installation not found or does not belong to tenant (installation_id=${opts.installationId})`,
    })
  }
}
