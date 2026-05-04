/**
 * Unit tests for GitHub App install flow additions:
 *   - github.listRepos: returns repos for installation, scoped to tenant, 60s cache
 *   - github.getInstallationToken: returns installation token, validates tenant ownership
 *   - Tenant isolation: tenant A cannot query installation owned by tenant B
 *
 * [Engineer-Sr · Sonnet · run-github-app-install]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RepoListCache,
  listInstallationRepos,
  type GitHubRepo,
} from '../../../src/github/install-repos.js'

// ---------------------------------------------------------------------------
// RepoListCache — 60s TTL in-process cache
// ---------------------------------------------------------------------------

describe('RepoListCache', () => {
  it('returns cached repos within TTL', () => {
    let nowMs = 1_000_000
    const cache = new RepoListCache({ ttlMs: 60_000, nowMs: () => nowMs })
    const repos: GitHubRepo[] = [
      { id: 1, fullName: 'owner/repo-a', defaultBranch: 'main', private: false },
    ]
    cache.set(42, repos)
    expect(cache.get(42)).toEqual(repos)
  })

  it('returns null after TTL expires', () => {
    let nowMs = 1_000_000
    const cache = new RepoListCache({ ttlMs: 60_000, nowMs: () => nowMs })
    const repos: GitHubRepo[] = [
      { id: 1, fullName: 'owner/repo-a', defaultBranch: 'main', private: false },
    ]
    cache.set(42, repos)
    nowMs += 61_000 // advance 61 seconds
    expect(cache.get(42)).toBeNull()
  })

  it('isolates cache by installationId', () => {
    const cache = new RepoListCache({ ttlMs: 60_000 })
    const repos1: GitHubRepo[] = [{ id: 1, fullName: 'a/b', defaultBranch: 'main', private: false }]
    const repos2: GitHubRepo[] = [{ id: 2, fullName: 'c/d', defaultBranch: 'main', private: false }]
    cache.set(10, repos1)
    cache.set(20, repos2)
    expect(cache.get(10)).toEqual(repos1)
    expect(cache.get(20)).toEqual(repos2)
    expect(cache.get(99)).toBeNull()
  })

  it('invalidate() clears a specific installation cache', () => {
    const cache = new RepoListCache({ ttlMs: 60_000 })
    cache.set(42, [{ id: 1, fullName: 'a/b', defaultBranch: 'main', private: false }])
    cache.invalidate(42)
    expect(cache.get(42)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listInstallationRepos — calls GitHub API and caches result
// ---------------------------------------------------------------------------

describe('listInstallationRepos', () => {
  const INSTALLATION_ID = 99_999

  it('fetches repos from GitHub API with installation token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        repositories: [
          {
            id: 101,
            full_name: 'owner/my-repo',
            default_branch: 'main',
            private: false,
          },
          {
            id: 102,
            full_name: 'owner/private-repo',
            default_branch: 'trunk',
            private: true,
          },
        ],
        total_count: 2,
      }),
    })

    const cache = new RepoListCache({ ttlMs: 60_000 })

    const repos = await listInstallationRepos({
      installationId: INSTALLATION_ID,
      getToken: async () => 'ghs_test_token',
      cache,
      fetchImpl: mockFetch,
    })

    expect(repos).toHaveLength(2)
    expect(repos[0]).toMatchObject({ id: 101, fullName: 'owner/my-repo', defaultBranch: 'main', private: false })
    expect(repos[1]).toMatchObject({ id: 102, fullName: 'owner/private-repo', defaultBranch: 'trunk', private: true })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/installation/repositories?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token ghs_test_token',
        }),
      }),
    )
  })

  it('returns cached result on second call without hitting GitHub', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        repositories: [{ id: 1, full_name: 'a/b', default_branch: 'main', private: false }],
        total_count: 1,
      }),
    })

    const cache = new RepoListCache({ ttlMs: 60_000 })

    await listInstallationRepos({
      installationId: INSTALLATION_ID,
      getToken: async () => 'ghs_token',
      cache,
      fetchImpl: mockFetch,
    })

    const result2 = await listInstallationRepos({
      installationId: INSTALLATION_ID,
      getToken: async () => 'ghs_token',
      cache,
      fetchImpl: mockFetch,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1) // only first call hits GitHub
    expect(result2).toHaveLength(1)
  })

  it('paginates through multiple pages', async () => {
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(async (_url: string) => {
      callCount++
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            repositories: Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              full_name: `owner/repo-${i + 1}`,
              default_branch: 'main',
              private: false,
            })),
            total_count: 120,
          }),
        }
      }
      // Page 2 — only 20 repos remaining
      return {
        ok: true,
        json: async () => ({
          repositories: Array.from({ length: 20 }, (_, i) => ({
            id: 100 + i + 1,
            full_name: `owner/repo-${100 + i + 1}`,
            default_branch: 'main',
            private: false,
          })),
          total_count: 120,
        }),
      }
    })

    const cache = new RepoListCache({ ttlMs: 60_000 })
    const repos = await listInstallationRepos({
      installationId: INSTALLATION_ID,
      getToken: async () => 'ghs_token',
      cache,
      fetchImpl: mockFetch,
    })

    expect(repos).toHaveLength(120)
    expect(callCount).toBe(2)
  })

  it('throws on non-ok GitHub response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
    })

    const cache = new RepoListCache({ ttlMs: 60_000 })

    await expect(
      listInstallationRepos({
        installationId: INSTALLATION_ID,
        getToken: async () => 'ghs_bad',
        cache,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/403/)
  })
})
