/**
 * scm/factory.ts — Composition root for ScmClient.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * Domain code asks the factory for an ScmClient given a project's
 * `scmProvider` setting. The factory is the only place that knows about
 * concrete providers; everything downstream is provider-agnostic.
 */

import type { ScmClient } from './client.js'
import { createCodeCommitScmClient } from './codecommit-client.js'
import { createGithubScmAdapter, type GithubScmAdapterOptions } from './github-adapter.js'
import type { GithubClient } from '../github/client.js'

export type ScmProvider = 'internal' | 'codecommit' | 'github'

export interface ProjectScmDescriptor {
  scmProvider: ScmProvider
  /** Required for github (and useful for codecommit lookups). */
  repoId?: string | null
}

export interface ScmFactoryOptions {
  region?: string
  /** Required to construct the github adapter on demand. */
  githubClient?: GithubClient
  github?: GithubScmAdapterOptions
}

/**
 * Resolve an ScmClient for a project. `internal` is treated as an alias for
 * `codecommit` (the default Orbital-managed SCM).
 */
export function getScmClient(
  project: ProjectScmDescriptor,
  options: ScmFactoryOptions = {},
): ScmClient {
  const provider: ScmProvider =
    project.scmProvider === 'internal' ? 'codecommit' : project.scmProvider

  switch (provider) {
    case 'codecommit':
      return createCodeCommitScmClient({ region: options.region })
    case 'github': {
      if (!options.githubClient) {
        throw new Error(
          'ScmFactory: github provider selected but no GithubClient was supplied',
        )
      }
      return createGithubScmAdapter(options.githubClient, options.github)
    }
    default: {
      const exhaustive: never = provider
      throw new Error(`ScmFactory: unsupported provider ${exhaustive as string}`)
    }
  }
}
