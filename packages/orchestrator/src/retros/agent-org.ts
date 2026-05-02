/**
 * agent-org.ts - The agent-organization Git repository wrapper.
 *
 * Per TRD-10 §11.1 and Phase 5B brief.
 *
 * Layout (per TRD-10 §11.1):
 *   ~/.orbital/agent-org/
 *     personas/
 *     skills/
 *     hooks/
 *     orchestrator/
 *     environment/
 *     routing/
 *     board/
 *     ceremonies/
 *     VERSION
 *
 * Why Git: change management of the agent organization is the audit-evidence
 * substrate. Diffs, signed commits, tags, and reverts are the artifacts
 * auditors expect. The DB tables (`system_versions`, `system_version_diffs`)
 * are an INDEX over the canonical Git history; the SHA is canonical.
 *
 * This module shells out to the system `git` binary via
 * node:child_process.execFileSync. No JS Git library is used.
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { OrbitalError } from '@orbital/types'
import { getOrbitalHome } from '../config/env.js'
import { logger } from '../config/logger.js'
import type { CommitInfo } from './types.js'

// ---------------------------------------------------------------------------
// Repo layout subdirs (created on init)
// ---------------------------------------------------------------------------

const SUBDIRS = [
  'personas',
  'skills',
  'hooks',
  'orchestrator',
  'environment',
  'routing',
  'board',
  'ceremonies',
] as const

// ---------------------------------------------------------------------------
// Repo class
// ---------------------------------------------------------------------------

export interface AgentOrgRepoOptions {
  /** Override the default root path. If unset, defaults to {ORBITAL_HOME}/agent-org. */
  path?: string
  /** Author name for commits. Default 'Orbital'. */
  authorName?: string
  /** Author email for commits. Default 'orbital@localhost'. */
  authorEmail?: string
}

export class AgentOrgRepo {
  public readonly path: string
  private readonly authorName: string
  private readonly authorEmail: string

  constructor(opts: AgentOrgRepoOptions = {}) {
    this.path = opts.path ?? path.join(getOrbitalHome(), 'agent-org')
    this.authorName = opts.authorName ?? 'Orbital'
    this.authorEmail = opts.authorEmail ?? 'orbital@localhost'
  }

  // -------------------------------------------------------------------------
  // init - create repo if not present, run initial commit, scaffold subdirs.
  // -------------------------------------------------------------------------

  /**
   * Initialize the agent-org repository if not already present. Creates the
   * directory and subdirectories, runs `git init`, sets local git config
   * (user.name and user.email), and produces an initial empty commit.
   *
   * Idempotent: a second call against an already-initialized repo is a no-op.
   */
  async init(): Promise<void> {
    const isInitialized = await this.isInitialized()
    if (isInitialized) {
      logger.debug({ path: this.path }, 'AgentOrgRepo: already initialized')
      return
    }

    await fs.mkdir(this.path, { recursive: true })

    // git init
    this.git(['init', '--initial-branch=main'])

    // Configure user.name + user.email locally so commits work without
    // depending on the user's global git config.
    this.git(['config', 'user.name', this.authorName])
    this.git(['config', 'user.email', this.authorEmail])

    // Scaffold subdirs as a useful starting point.
    for (const sub of SUBDIRS) {
      const dir = path.join(this.path, sub)
      await fs.mkdir(dir, { recursive: true })
      // Place a .gitkeep so empty dirs survive the initial commit.
      const keep = path.join(dir, '.gitkeep')
      if (!existsSync(keep)) {
        await fs.writeFile(keep, '')
      }
    }

    // VERSION file
    const versionPath = path.join(this.path, 'VERSION')
    if (!existsSync(versionPath)) {
      await fs.writeFile(versionPath, 'org-v0.0.0\n')
    }

    // Stage everything; allow-empty ensures we always have an initial commit
    // even if no scaffold files were created (defensive).
    this.git(['add', '-A'])
    this.git(['commit', '--allow-empty', '-m', 'initial: agent-org genesis'])

    logger.info({ path: this.path }, 'AgentOrgRepo: initialized')
  }

  // -------------------------------------------------------------------------
  // isInitialized - check whether `path/.git` exists.
  // -------------------------------------------------------------------------

  async isInitialized(): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(this.path, '.git'))
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // commit - write file, stage, commit, return SHA.
  // -------------------------------------------------------------------------

  /**
   * Write the given file content (creating parent directories), `git add` it,
   * and produce a commit with the supplied message and author. Returns the
   * full SHA of the resulting commit.
   *
   * If the file content is identical to what is already in the working tree
   * (no diff), this method still runs `git commit --allow-empty` so callers
   * always get a new commit hash. This matches the system_versions invariant
   * that approval always creates a new version (TRD-10 §7.2).
   *
   * @throws OrbitalError('INTEGRATION_GIT_CONFLICT', ...) on Git failures.
   */
  async commit(
    relativePath: string,
    content: string,
    message: string,
    author?: string,
  ): Promise<string> {
    if (!(await this.isInitialized())) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `AgentOrgRepo at ${this.path} is not initialized; call init() first`,
      )
    }

    // Reject absolute paths and parent escapes early; otherwise the resulting
    // file would land outside the repo.
    if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `relativePath '${relativePath}' must be a repo-relative path without '..' segments`,
      )
    }

    const targetPath = path.join(this.path, relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, content)

    this.git(['add', '--', relativePath])

    // Build the commit args.
    const args = ['commit', '--allow-empty', '-m', message]
    if (author) {
      args.push(`--author=${author}`)
    }
    try {
      this.git(args)
    } catch (err) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `git commit failed: ${(err as Error).message}`,
      )
    }

    const sha = this.git(['rev-parse', 'HEAD']).trim()
    logger.debug({ sha, relativePath, message }, 'AgentOrgRepo: committed')
    return sha
  }

  // -------------------------------------------------------------------------
  // readFile - read file at HEAD; null if missing.
  // -------------------------------------------------------------------------

  /**
   * Read a file from the working tree (HEAD). Returns null if the file does
   * not exist.
   */
  async readFile(relativePath: string): Promise<string | null> {
    const target = path.join(this.path, relativePath)
    try {
      return await fs.readFile(target, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // reset - hard reset to the given commit.
  // -------------------------------------------------------------------------

  /**
   * Hard-reset the repo to the supplied commit hash. Used by the rollback
   * code path. The reset is destructive and intended; subsequent commits
   * branch from this point.
   */
  async reset(toCommitHash: string): Promise<void> {
    if (!(await this.isInitialized())) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `AgentOrgRepo at ${this.path} is not initialized`,
      )
    }
    try {
      this.git(['reset', '--hard', toCommitHash])
      logger.info({ to: toCommitHash, path: this.path }, 'AgentOrgRepo: reset')
    } catch (err) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `git reset failed: ${(err as Error).message}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // log - return commit history (newest first).
  // -------------------------------------------------------------------------

  /**
   * Return the commit history (newest first), bounded by the supplied limit.
   * Each entry contains the full SHA, short SHA (7 chars), commit message
   * (subject only), author name, and ISO timestamp.
   */
  async log(limit = 50): Promise<CommitInfo[]> {
    if (!(await this.isInitialized())) {
      return []
    }
    // Sentinel chars that won't appear in author/message.
    const sep = '\x1f' // unit separator
    const recSep = '\x1e' // record separator
    const fmt = `%H${sep}%h${sep}%s${sep}%an${sep}%aI${recSep}`

    let output: string
    try {
      output = this.git(['log', `--max-count=${limit}`, `--pretty=format:${fmt}`])
    } catch (err) {
      // Fresh repo with no commits would normally error; we already inserted
      // an initial commit during init(). Defensive fallback.
      logger.debug({ err: (err as Error).message }, 'AgentOrgRepo: log returned no commits')
      return []
    }

    return output
      .split(recSep)
      .map((rec) => rec.trim())
      .filter((rec) => rec.length > 0)
      .map((rec) => {
        const [hash, shortHash, message, author, date] = rec.split(sep)
        return {
          hash: hash ?? '',
          shortHash: shortHash ?? '',
          message: message ?? '',
          author: author ?? '',
          date: date ?? '',
        }
      })
  }

  // -------------------------------------------------------------------------
  // Utility: head SHA
  // -------------------------------------------------------------------------

  async headSha(): Promise<string> {
    if (!(await this.isInitialized())) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `AgentOrgRepo at ${this.path} is not initialized`,
      )
    }
    return this.git(['rev-parse', 'HEAD']).trim()
  }

  // -------------------------------------------------------------------------
  // Utility: parent SHA of a given commit (or null if it has no parent).
  // -------------------------------------------------------------------------

  async parentOf(commitHash: string): Promise<string | null> {
    try {
      return this.git(['rev-parse', `${commitHash}^`]).trim()
    } catch {
      // Initial commit has no parent.
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Utility: tag the HEAD commit with a name.
  // -------------------------------------------------------------------------

  async tag(tagName: string, message?: string): Promise<void> {
    const args = ['tag', '-a', tagName, '-m', message ?? tagName]
    try {
      this.git(args)
    } catch (err) {
      throw new OrbitalError(
        'INTEGRATION_GIT_CONFLICT',
        `git tag failed: ${(err as Error).message}`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Utility: list the files changed in a commit.
  // -------------------------------------------------------------------------

  async filesChanged(commitHash: string): Promise<string[]> {
    try {
      const output = this.git([
        'show',
        '--no-color',
        '--name-only',
        '--pretty=format:',
        commitHash,
      ])
      return output
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Utility: show the unified diff for a commit (truncated).
  // -------------------------------------------------------------------------

  async unifiedDiff(commitHash: string, maxBytes = 200_000): Promise<string> {
    try {
      const output = this.git([
        'show',
        '--no-color',
        '--patch',
        '--pretty=format:',
        commitHash,
      ])
      if (output.length > maxBytes) {
        return output.slice(0, maxBytes) + '\n... (truncated)\n'
      }
      return output
    } catch {
      return ''
    }
  }

  // -------------------------------------------------------------------------
  // Internal: shell out to `git` synchronously and return stdout.
  // -------------------------------------------------------------------------

  private git(args: string[]): string {
    try {
      const out = execFileSync('git', args, {
        cwd: this.path,
        encoding: 'utf8',
        // Inherit stderr so failures surface in logs; capture stdout only.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure the local config wins.
          GIT_AUTHOR_NAME: this.authorName,
          GIT_AUTHOR_EMAIL: this.authorEmail,
          GIT_COMMITTER_NAME: this.authorName,
          GIT_COMMITTER_EMAIL: this.authorEmail,
        },
      })
      return out
    } catch (err) {
      const e = err as Error & { stderr?: Buffer; stdout?: Buffer }
      const stderr = e.stderr?.toString() ?? ''
      throw new Error(`git ${args.join(' ')} failed: ${stderr || e.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentOrgRepo(opts: AgentOrgRepoOptions = {}): AgentOrgRepo {
  return new AgentOrgRepo(opts)
}
