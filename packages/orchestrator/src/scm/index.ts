/**
 * scm/index.ts — Public re-exports for the SCM bounded context.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 */

export type {
  ScmClient,
  ScmFile,
  ScmRepoHandle,
  ScmDifferenceFile,
  ScmPullRequestStatus,
  ScmMergeMethod,
  ScmUnifiedDiffFile,
  ScmUnifiedHunk,
  ScmUnifiedHunkLine,
} from './client.js'

export { CodeCommitScmClient, createCodeCommitScmClient } from './codecommit-client.js'
export type { CodeCommitScmClientOptions } from './codecommit-client.js'

export { GithubScmAdapter, createGithubScmAdapter } from './github-adapter.js'
export type { GithubScmAdapterOptions } from './github-adapter.js'

export {
  getScmClient,
  type ScmProvider,
  type ProjectScmDescriptor,
  type ScmFactoryOptions,
} from './factory.js'
