/**
 * scm/codecommit-client.ts — Real AWS CodeCommit ScmClient.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * Maps the domain ScmClient interface onto the AWS CodeCommit API.
 *
 * Notes on CodeCommit semantics that drive the mapping:
 *   - Repos are identified by *name* within an account+region. There is no
 *     numeric id. We expose the name as `repoId`.
 *   - A new repo has no commits and no branches. To create a branch via
 *     CreateBranch you need a commit SHA — we therefore land an initial
 *     README commit when the caller hits createRepo+commitFiles in
 *     sequence (see scm.commitFiles handling for the empty-repo case).
 *   - PutFile / CreateCommit work without a working copy — both take the
 *     parent commit id and (for multi-file commits) a list of putFiles
 *     with file mode + content. We use CreateCommit for multi-file commits
 *     and PutFile for the single-file fast path.
 *   - PR ids are strings. There are three merge endpoints (three-way,
 *     squash, fast-forward); we map our `merge`/`squash`/`rebase` method
 *     to those (rebase → fast-forward, the closest semantic).
 *   - GetDifferences returns a list of file-level diffs with blob refs
 *     but does not return additions/deletions counts. We compute those
 *     by fetching each blob via GetBlob and diffing line counts.
 */

import {
  CodeCommitClient,
  CreateRepositoryCommand,
  GetRepositoryCommand,
  CreateBranchCommand,
  GetBranchCommand,
  CreateCommitCommand,
  PutFileCommand,
  GetFolderCommand,
  GetCommitCommand,
  GetBlobCommand,
  CreatePullRequestCommand,
  GetPullRequestCommand,
  PostCommentForPullRequestCommand,
  MergePullRequestByThreeWayCommand,
  MergePullRequestBySquashCommand,
  MergePullRequestByFastForwardCommand,
  GetDifferencesCommand,
  type PutFileEntry,
  type DeleteFileEntry,
  RepositoryNameExistsException,
} from '@aws-sdk/client-codecommit'

import { logger } from '../config/logger.js'
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodeCommitScmClientOptions {
  region?: string
  /** Override the underlying SDK client (test seam). */
  sdk?: CodeCommitClient
  /** Author name applied to commits. Default 'Orbital'. */
  authorName?: string
  /** Author email applied to commits. Default 'noreply@orbital.local'. */
  authorEmail?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_BRANCH = 'main'

export class CodeCommitScmClient implements ScmClient {
  readonly provider = 'codecommit' as const
  private readonly sdk: CodeCommitClient
  private readonly region: string
  private readonly authorName: string
  private readonly authorEmail: string

  constructor(options: CodeCommitScmClientOptions = {}) {
    this.region = options.region ?? process.env['AWS_REGION'] ?? 'us-east-1'
    this.sdk = options.sdk ?? new CodeCommitClient({ region: this.region })
    this.authorName = options.authorName ?? 'Orbital'
    this.authorEmail = options.authorEmail ?? 'noreply@orbital.local'
  }

  // -------------------------------------------------------------------------
  // Repos
  // -------------------------------------------------------------------------

  async createRepo(name: string, description?: string): Promise<ScmRepoHandle> {
    try {
      const out = await this.sdk.send(
        new CreateRepositoryCommand({
          repositoryName: name,
          repositoryDescription: description,
        }),
      )
      const md = out.repositoryMetadata
      if (!md) throw new Error('CreateRepository returned no metadata')
      return this.toHandle(name, md.cloneUrlHttp ?? this.deriveCloneUrl(name))
    } catch (err) {
      // Idempotency: if the repo already exists, treat as success.
      if (
        err instanceof RepositoryNameExistsException ||
        (err as { name?: string })?.name === 'RepositoryNameExistsException'
      ) {
        logger.info({ name }, 'CodeCommitScmClient: repo already exists, returning existing handle')
        const got = await this.sdk.send(new GetRepositoryCommand({ repositoryName: name }))
        const md = got.repositoryMetadata
        return this.toHandle(name, md?.cloneUrlHttp ?? this.deriveCloneUrl(name))
      }
      throw err
    }
  }

  async getRepoUrl(repoId: string): Promise<string> {
    return this.deriveConsoleUrl(repoId)
  }

  async cloneUrl(repoId: string): Promise<string> {
    const got = await this.sdk.send(new GetRepositoryCommand({ repositoryName: repoId }))
    return got.repositoryMetadata?.cloneUrlHttp ?? this.deriveCloneUrl(repoId)
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  async createBranch(
    repoId: string,
    name: string,
    fromRef: string,
  ): Promise<{ name: string; commitSha: string }> {
    const sha = await this.resolveCommitSha(repoId, fromRef)
    await this.sdk.send(
      new CreateBranchCommand({
        repositoryName: repoId,
        branchName: name,
        commitId: sha,
      }),
    )
    return { name, commitSha: sha }
  }

  // -------------------------------------------------------------------------
  // Commits
  // -------------------------------------------------------------------------

  async commitFiles(
    repoId: string,
    branch: string,
    files: ScmFile[],
    message: string,
  ): Promise<{ commitSha: string }> {
    if (files.length === 0) throw new Error('commitFiles requires at least one file')

    const putFiles: PutFileEntry[] = files.map((f) => ({
      filePath: normalisePath(f.path),
      fileMode: 'NORMAL',
      fileContent: toBytes(f),
    }))

    const parentCommitId = await this.resolveBranchCommitOrNull(repoId, branch)

    // Fast path: empty repo (no commits yet) — use PutFile for the very first
    // file and CreateCommit for any remaining ones in a chain. PutFile is the
    // only API that accepts no parentCommitId on the default branch.
    if (parentCommitId === null) {
      // Initial commit via PutFile (single file). For multi-file initial
      // commits we follow with a CreateCommit chain.
      const first = files[0]!
      const initial = await this.sdk.send(
        new PutFileCommand({
          repositoryName: repoId,
          branchName: branch,
          filePath: normalisePath(first.path),
          fileContent: toBytes(first),
          commitMessage: files.length === 1 ? message : `${message} (1/${files.length})`,
          name: this.authorName,
          email: this.authorEmail,
        }),
      )
      let parent: string = initial.commitId ?? ''
      if (!parent) throw new Error('PutFile returned no commitId on initial commit')

      for (let i = 1; i < files.length; i++) {
        const f = files[i]!
        const nextOut = await this.sdk.send(
          new CreateCommitCommand({
            repositoryName: repoId,
            branchName: branch,
            parentCommitId: parent,
            authorName: this.authorName,
            email: this.authorEmail,
            commitMessage: `${message} (${i + 1}/${files.length})`,
            putFiles: [
              {
                filePath: normalisePath(f.path),
                fileMode: 'NORMAL',
                fileContent: toBytes(f),
              },
            ],
          }),
        )
        if (!nextOut.commitId) throw new Error('CreateCommit returned no commitId')
        parent = nextOut.commitId
      }
      return { commitSha: parent }
    }

    // Normal path: branch exists, single CreateCommit with all files.
    const out = await this.sdk.send(
      new CreateCommitCommand({
        repositoryName: repoId,
        branchName: branch,
        parentCommitId,
        authorName: this.authorName,
        email: this.authorEmail,
        commitMessage: message,
        putFiles,
      }),
    )
    if (!out.commitId) throw new Error('CreateCommit returned no commitId')
    return { commitSha: out.commitId }
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  async openPullRequest(
    repoId: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ prId: string; url: string }> {
    const out = await this.sdk.send(
      new CreatePullRequestCommand({
        title,
        description: body,
        targets: [
          {
            repositoryName: repoId,
            sourceReference: head,
            destinationReference: base,
          },
        ],
      }),
    )
    const id = out.pullRequest?.pullRequestId
    if (!id) throw new Error('CreatePullRequest returned no pullRequestId')
    return { prId: id, url: this.derivePrUrl(repoId, id) }
  }

  async getPullRequestStatus(_repoId: string, prId: string): Promise<ScmPullRequestStatus> {
    const out = await this.sdk.send(new GetPullRequestCommand({ pullRequestId: prId }))
    const pr = out.pullRequest
    if (!pr) throw new Error(`GetPullRequest returned no body for ${prId}`)
    const target = pr.pullRequestTargets?.[0]
    const status = pr.pullRequestStatus
    const mergeMetadata = target?.mergeMetadata
    const isMerged = mergeMetadata?.isMerged === true
    const state: ScmPullRequestStatus['state'] = isMerged
      ? 'merged'
      : status === 'CLOSED'
        ? 'closed'
        : 'open'
    return {
      state,
      mergeable: null,
      title: pr.title ?? '',
      body: pr.description ?? null,
      head: target?.sourceReference ?? '',
      base: target?.destinationReference ?? '',
    }
  }

  async addPRComment(repoId: string, prId: string, body: string): Promise<void> {
    // PostCommentForPullRequest needs before/after commit ids — use the
    // current source/destination commits.
    const pr = await this.sdk.send(new GetPullRequestCommand({ pullRequestId: prId }))
    const target = pr.pullRequest?.pullRequestTargets?.[0]
    const beforeCommitId = target?.destinationCommit
    const afterCommitId = target?.sourceCommit
    if (!beforeCommitId || !afterCommitId) {
      throw new Error(`PR ${prId} missing source/destination commit ids`)
    }
    await this.sdk.send(
      new PostCommentForPullRequestCommand({
        pullRequestId: prId,
        repositoryName: repoId,
        beforeCommitId,
        afterCommitId,
        content: body,
      }),
    )
  }

  async mergePR(
    repoId: string,
    prId: string,
    method: ScmMergeMethod = 'merge',
  ): Promise<{ commitSha: string }> {
    const pr = await this.sdk.send(new GetPullRequestCommand({ pullRequestId: prId }))
    const target = pr.pullRequest?.pullRequestTargets?.[0]
    const sourceCommitId = target?.sourceCommit
    if (!sourceCommitId) throw new Error(`PR ${prId} missing sourceCommit`)

    switch (method) {
      case 'squash': {
        const out = await this.sdk.send(
          new MergePullRequestBySquashCommand({
            pullRequestId: prId,
            repositoryName: repoId,
            sourceCommitId,
            authorName: this.authorName,
            email: this.authorEmail,
          }),
        )
        return { commitSha: out.pullRequest?.pullRequestTargets?.[0]?.mergeMetadata?.mergeCommitId ?? sourceCommitId }
      }
      case 'rebase': {
        const out = await this.sdk.send(
          new MergePullRequestByFastForwardCommand({
            pullRequestId: prId,
            repositoryName: repoId,
            sourceCommitId,
          }),
        )
        return { commitSha: out.pullRequest?.pullRequestTargets?.[0]?.mergeMetadata?.mergeCommitId ?? sourceCommitId }
      }
      case 'merge':
      default: {
        const out = await this.sdk.send(
          new MergePullRequestByThreeWayCommand({
            pullRequestId: prId,
            repositoryName: repoId,
            sourceCommitId,
            authorName: this.authorName,
            email: this.authorEmail,
          }),
        )
        return { commitSha: out.pullRequest?.pullRequestTargets?.[0]?.mergeMetadata?.mergeCommitId ?? sourceCommitId }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Diffs
  // -------------------------------------------------------------------------

  async getDifferences(
    repoId: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ files: ScmDifferenceFile[] }> {
    const collected: ScmDifferenceFile[] = []
    let nextToken: string | undefined
    do {
      const out = await this.sdk.send(
        new GetDifferencesCommand({
          repositoryName: repoId,
          beforeCommitSpecifier: fromRef,
          afterCommitSpecifier: toRef,
          NextToken: nextToken,
        }),
      )
      for (const d of out.differences ?? []) {
        const path = d.afterBlob?.path ?? d.beforeBlob?.path ?? ''
        const changeType = mapChangeType(d.changeType)
        const oldBlob = d.beforeBlob?.blobId ?? null
        const newBlob = d.afterBlob?.blobId ?? null
        const { additions, deletions } = await this.countLineDiff(repoId, oldBlob, newBlob)
        collected.push({ path, oldBlob, newBlob, additions, deletions, changeType })
      }
      nextToken = out.NextToken
    } while (nextToken)
    return { files: collected }
  }

  async getUnifiedDiff(
    repoId: string,
    fromRef: string,
    toRef: string,
  ): Promise<{ files: ScmUnifiedDiffFile[] }> {
    const { files: rawFiles } = await this.getDifferences(repoId, fromRef, toRef)
    const out: ScmUnifiedDiffFile[] = []
    for (const f of rawFiles) {
      const [oldText, newText] = await Promise.all([
        f.oldBlob ? this.fetchBlobText(repoId, f.oldBlob) : Promise.resolve(null),
        f.newBlob ? this.fetchBlobText(repoId, f.newBlob) : Promise.resolve(null),
      ])
      const diff = computeUnifiedDiff(oldText, newText)
      out.push({
        path: f.path,
        oldPath: null,
        changeType: f.changeType,
        additions: diff.additions || f.additions,
        deletions: diff.deletions || f.deletions,
        binary: diff.binary,
        hunks: diff.hunks,
      })
    }
    return { files: out }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async fetchBlobText(repoId: string, blobId: string): Promise<string | null> {
    try {
      const out = await this.sdk.send(
        new GetBlobCommand({ repositoryName: repoId, blobId }),
      )
      const content = out.content
      if (!content) return null
      return Buffer.from(content).toString('utf-8')
    } catch (err) {
      logger.warn({ blobId, err }, 'CodeCommitScmClient.fetchBlobText failed')
      return null
    }
  }

  private toHandle(name: string, cloneUrlHttp: string): ScmRepoHandle {
    return {
      repoId: name,
      repoUrl: this.deriveConsoleUrl(name),
      cloneUrlHttp,
    }
  }

  private deriveCloneUrl(name: string): string {
    return `https://git-codecommit.${this.region}.amazonaws.com/v1/repos/${name}`
  }

  private deriveConsoleUrl(name: string): string {
    return `https://${this.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${name}/browse?region=${this.region}`
  }

  private derivePrUrl(repoName: string, prId: string): string {
    return `https://${this.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${repoName}/pull-requests/${prId}/details?region=${this.region}`
  }

  private async resolveCommitSha(repoId: string, ref: string): Promise<string> {
    // Heuristic: 40-char hex looks like a sha; otherwise treat as branch name.
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref
    const out = await this.sdk.send(
      new GetBranchCommand({ repositoryName: repoId, branchName: ref }),
    )
    const sha = out.branch?.commitId
    if (!sha) throw new Error(`Branch ${ref} on ${repoId} has no commit id`)
    return sha
  }

  private async resolveBranchCommitOrNull(repoId: string, branch: string): Promise<string | null> {
    try {
      const out = await this.sdk.send(
        new GetBranchCommand({ repositoryName: repoId, branchName: branch }),
      )
      return out.branch?.commitId ?? null
    } catch (err) {
      const name = (err as { name?: string })?.name
      if (name === 'BranchDoesNotExistException' || name === 'RepositoryEmptyException') {
        return null
      }
      // CodeCommit returns RepositoryNotFoundException for empty repos in some
      // edge cases — re-throw, the caller's createRepo path should have run.
      throw err
    }
  }

  private async countLineDiff(
    repoId: string,
    oldBlob: string | null,
    newBlob: string | null,
  ): Promise<{ additions: number; deletions: number }> {
    // Cheap, conservative: count lines in each blob; net delta is treated
    // as additions/deletions. This avoids pulling a full diff library into
    // the lambda bundle.
    const [before, after] = await Promise.all([
      oldBlob ? this.fetchBlobLines(repoId, oldBlob) : 0,
      newBlob ? this.fetchBlobLines(repoId, newBlob) : 0,
    ])
    if (before === 0 && after > 0) return { additions: after, deletions: 0 }
    if (after === 0 && before > 0) return { additions: 0, deletions: before }
    if (after >= before) return { additions: after - before, deletions: 0 }
    return { additions: 0, deletions: before - after }
  }

  private async fetchBlobLines(repoId: string, blobId: string): Promise<number> {
    try {
      const out = await this.sdk.send(
        new GetBlobCommand({ repositoryName: repoId, blobId }),
      )
      const content = out.content
      if (!content) return 0
      // content is Uint8Array
      const text = Buffer.from(content).toString('utf-8')
      // Empty file → 0; otherwise count newline-separated chunks.
      if (text.length === 0) return 0
      return text.split('\n').length
    } catch (err) {
      logger.warn({ blobId, err }, 'CodeCommitScmClient.fetchBlobLines failed')
      return 0
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

function toBytes(f: ScmFile): Uint8Array {
  if (f.content_utf8 !== undefined) {
    return new TextEncoder().encode(f.content_utf8)
  }
  if (f.content_base64 !== undefined) {
    return new Uint8Array(Buffer.from(f.content_base64, 'base64'))
  }
  throw new Error(`ScmFile ${f.path} requires content_utf8 or content_base64`)
}

function mapChangeType(ct: string | undefined): ScmDifferenceFile['changeType'] {
  switch (ct) {
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'M':
      return 'M'
    case 'R':
      return 'R'
    default:
      return 'M'
  }
}

// Keep imports live for future support without a lint flag.
void (null as unknown as DeleteFileEntry | null)
void GetFolderCommand
void GetCommitCommand

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodeCommitScmClient(
  options: CodeCommitScmClientOptions = {},
): ScmClient {
  return new CodeCommitScmClient(options)
}
