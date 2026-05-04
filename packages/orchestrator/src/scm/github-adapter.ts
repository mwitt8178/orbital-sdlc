/**
 * scm/github-adapter.ts — Wraps the existing GithubClient as an ScmClient.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * The existing github/client.ts is an `owner/repo`-shaped REST client.
 * This adapter exposes the same operations behind the provider-agnostic
 * ScmClient port. `repoId` is encoded as `${owner}/${repo}`.
 */

import type { GithubClient } from '../github/client.js'
import type {
  ScmClient,
  ScmFile,
  ScmRepoHandle,
  ScmPullRequestStatus,
  ScmDifferenceFile,
  ScmMergeMethod,
  ScmUnifiedDiffFile,
} from './client.js'
import { computeUnifiedDiff } from './unified-diff.js'

export interface GithubScmAdapterOptions {
  /** Default owner used by createRepo if the caller doesn't encode one. */
  defaultOwner?: string
  /** When set, repos are created under this org rather than the user. */
  org?: string
}

export class GithubScmAdapter implements ScmClient {
  readonly provider = 'github' as const

  constructor(
    private readonly gh: GithubClient,
    private readonly options: GithubScmAdapterOptions = {},
  ) {}

  async createRepo(name: string, description?: string): Promise<ScmRepoHandle> {
    const repo = await this.gh.createRepo({
      name,
      private: true,
      description,
      org: this.options.org,
    })
    const repoId = `${repo.owner.login}/${repo.name}`
    return {
      repoId,
      repoUrl: repo.htmlUrl,
      cloneUrlHttp: `https://github.com/${repoId}.git`,
    }
  }

  async getRepoUrl(repoId: string): Promise<string> {
    const { owner, repo } = parseRepoId(repoId)
    const got = await this.gh.getRepo(owner, repo)
    return got?.htmlUrl ?? `https://github.com/${owner}/${repo}`
  }

  async cloneUrl(repoId: string): Promise<string> {
    const { owner, repo } = parseRepoId(repoId)
    return `https://github.com/${owner}/${repo}.git`
  }

  async createBranch(
    repoId: string,
    name: string,
    fromRef: string,
  ): Promise<{ name: string; commitSha: string }> {
    const { owner, repo } = parseRepoId(repoId)
    let sha = fromRef
    if (!/^[0-9a-f]{40}$/i.test(fromRef)) {
      const branch = await this.gh.getBranch(owner, repo, fromRef)
      if (!branch) throw new Error(`Branch ${fromRef} not found on ${repoId}`)
      sha = branch.commitSha
    }
    const created = await this.gh.createBranch(owner, repo, name, sha)
    return { name: created.name, commitSha: created.commitSha }
  }

  async commitFiles(
    repoId: string,
    branch: string,
    files: ScmFile[],
    message: string,
  ): Promise<{ commitSha: string }> {
    const { owner, repo } = parseRepoId(repoId)
    let lastSha = ''
    for (const f of files) {
      const content =
        f.content_base64 !== undefined
          ? f.content_base64
          : Buffer.from(f.content_utf8 ?? '', 'utf-8').toString('base64')
      // Look up existing file sha so PUT updates rather than 422s.
      let existingSha: string | undefined
      try {
        const got = await this.gh.rawRequest<{ sha?: string }>(
          'GET',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(branch)}`,
          undefined,
          { allow404: true },
        )
        existingSha = got?.sha
      } catch {
        existingSha = undefined
      }
      const res = await this.gh.rawRequest<{ commit: { sha: string } }>(
        'PUT',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(f.path)}`,
        {
          message,
          content,
          branch,
          ...(existingSha ? { sha: existingSha } : {}),
        },
      )
      if (!res?.commit?.sha) throw new Error(`PUT contents returned no commit sha for ${f.path}`)
      lastSha = res.commit.sha
    }
    return { commitSha: lastSha }
  }

  async openPullRequest(
    repoId: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ prId: string; url: string }> {
    const { owner, repo } = parseRepoId(repoId)
    const out = await this.gh.createPullRequest({ owner, repo, head, base, title, body })
    return { prId: String(out.pr_number), url: out.html_url }
  }

  async getPullRequestStatus(repoId: string, prId: string): Promise<ScmPullRequestStatus> {
    const { owner, repo } = parseRepoId(repoId)
    const pr = await this.gh.getPullRequest({ owner, repo, pr_number: Number(prId) })
    if (!pr) throw new Error(`PR ${prId} on ${repoId} not found`)
    return {
      state: pr.state,
      mergeable: null,
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base: pr.base,
    }
  }

  async addPRComment(repoId: string, prId: string, body: string): Promise<void> {
    const { owner, repo } = parseRepoId(repoId)
    await this.gh.rawRequest(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prId}/comments`,
      { body },
    )
  }

  async mergePR(
    repoId: string,
    prId: string,
    method: ScmMergeMethod = 'merge',
  ): Promise<{ commitSha: string }> {
    const { owner, repo } = parseRepoId(repoId)
    const out = await this.gh.mergePullRequest({
      owner,
      repo,
      pr_number: Number(prId),
      mergeMethod: method,
    })
    return { commitSha: out.sha }
  }

  async getDifferences(
    repoId: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ files: ScmDifferenceFile[] }> {
    const { owner, repo } = parseRepoId(repoId)
    const out = await this.gh.rawRequest<{
      files?: Array<{
        filename: string
        status: string
        additions: number
        deletions: number
        sha?: string
        previous_filename?: string
      }>
    }>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`,
    )
    const files = (out?.files ?? []).map((f) => ({
      path: f.filename,
      oldBlob: null,
      newBlob: f.sha ?? null,
      additions: f.additions,
      deletions: f.deletions,
      changeType: mapStatus(f.status),
    }))
    return { files }
  }

  async getUnifiedDiff(
    repoId: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ files: ScmUnifiedDiffFile[] }> {
    const { owner, repo } = parseRepoId(repoId)
    // Fetch each file's before/after raw content via the contents endpoint.
    // For large diffs this is many calls — acceptable since the Review UI
    // only loads on demand. Fall back to an empty hunk if a file's blob
    // cannot be retrieved.
    const compare = await this.gh.rawRequest<{
      files?: Array<{
        filename: string
        status: string
        additions: number
        deletions: number
        previous_filename?: string
        patch?: string
      }>
    }>(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(fromRef)}...${encodeURIComponent(toRef)}`,
    )
    const out: ScmUnifiedDiffFile[] = []
    for (const f of compare?.files ?? []) {
      const changeType = mapStatus(f.status)
      // GitHub already provides a `patch` text; parse it as best-effort.
      const hunks = f.patch ? parseGithubPatchHunks(f.patch) : []
      out.push({
        path: f.filename,
        oldPath: f.previous_filename ?? null,
        changeType,
        additions: f.additions,
        deletions: f.deletions,
        binary: !f.patch,
        hunks,
      })
    }
    void computeUnifiedDiff // exported to share types; fall-through for future use
    return { files: out }
  }
}

/** Best-effort unified-diff hunk parser for GitHub's `patch` field. */
function parseGithubPatchHunks(patch: string): import('./client.js').ScmUnifiedHunk[] {
  const hunks: import('./client.js').ScmUnifiedHunk[] = []
  const lines = patch.split('\n')
  let cur: import('./client.js').ScmUnifiedHunk | null = null
  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  for (const ln of lines) {
    const h = ln.match(headerRe)
    if (h) {
      if (cur) hunks.push(cur)
      cur = {
        oldStart: Number(h[1]),
        oldLines: h[2] ? Number(h[2]) : 1,
        newStart: Number(h[3]),
        newLines: h[4] ? Number(h[4]) : 1,
        lines: [],
      }
      continue
    }
    if (!cur) continue
    if (ln.startsWith('+')) cur.lines.push({ origin: '+', content: ln.slice(1) })
    else if (ln.startsWith('-')) cur.lines.push({ origin: '-', content: ln.slice(1) })
    else if (ln.startsWith(' ')) cur.lines.push({ origin: ' ', content: ln.slice(1) })
    // ignore '\ No newline at end of file' and other markers
  }
  if (cur) hunks.push(cur)
  return hunks
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRepoId(repoId: string): { owner: string; repo: string } {
  const [owner, repo] = repoId.split('/', 2)
  if (!owner || !repo) {
    throw new Error(`GithubScmAdapter expects repoId of form 'owner/repo', got ${repoId}`)
  }
  return { owner, repo }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

function mapStatus(s: string): ScmDifferenceFile['changeType'] {
  switch (s) {
    case 'added':
      return 'A'
    case 'removed':
      return 'D'
    case 'renamed':
      return 'R'
    default:
      return 'M'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGithubScmAdapter(
  gh: GithubClient,
  options: GithubScmAdapterOptions = {},
): ScmClient {
  return new GithubScmAdapter(gh, options)
}
