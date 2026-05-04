/**
 * worktree.ts — Local working copy management for story-pr runs.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 *
 * Responsibilities:
 *   1. Clone the project repo via the ScmClient-supplied clone URL.
 *   2. Create a feature branch off the default branch.
 *   3. After the agent runs, walk the working tree and produce ScmFile[]
 *      entries for the ScmClient.commitFiles call.
 *
 * This module never writes back to the remote directly — that goes through
 * ScmClient. Local git is purely the agent sandbox.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ScmFile } from '../scm/client.js'

const execFileP = promisify(execFile)

export interface WorktreeHandle {
  /** Absolute path to the working directory. */
  cwd: string
  /** Branch checked out. */
  branch: string
  /** Default branch the clone tracks. */
  defaultBranch: string
}

export interface CloneOptions {
  /** Provider clone URL (HTTPS). */
  cloneUrl: string
  /** Run id — used for the worktree directory name. */
  runId: string
  /** Default branch to clone (depth=1). */
  defaultBranch: string
  /** Optional auth header to inject — e.g. for github HTTPS basic auth. */
  authHeader?: string
}

/**
 * Clone the remote into /tmp/orbital-run-<runId>. Throws on git failure.
 *
 * Auth model:
 *   - CodeCommit: clone URL of form `https://git-codecommit.<region>.amazonaws.com/...`
 *     uses git-remote-codecommit (or aws codecommit credential-helper) which we
 *     assume is installed in the daemon image. If not, the caller falls back to
 *     ScmClient.commitFiles writing the initial commit and we don't actually
 *     need to clone (use scaffoldEmptyWorktree).
 *   - GitHub: caller passes an authHeader with basic-auth; we set it via
 *     `extraheader` so the token never lands in the URL.
 */
export async function cloneRepo(opts: CloneOptions): Promise<WorktreeHandle> {
  const cwd = path.join(tmpdir(), `orbital-run-${opts.runId}`)
  if (existsSync(cwd)) {
    await rm(cwd, { recursive: true, force: true })
  }
  await mkdir(cwd, { recursive: true })

  const args = ['clone', '--depth=1', '--branch', opts.defaultBranch]
  if (opts.authHeader) {
    args.push('-c', `http.extraheader=Authorization: ${opts.authHeader}`)
  }
  args.push(opts.cloneUrl, cwd)

  await execFileP('git', args, { timeout: 120_000 })

  // Configure committer identity so local commits the agent makes (if any) are
  // valid; we still push via ScmClient.commitFiles so this is mostly cosmetic.
  await execFileP('git', ['config', 'user.email', 'noreply@orbital.local'], { cwd })
  await execFileP('git', ['config', 'user.name', 'Orbital'], { cwd })

  return { cwd, branch: opts.defaultBranch, defaultBranch: opts.defaultBranch }
}

/**
 * Create and check out the agent branch off the current HEAD.
 */
export async function checkoutBranch(handle: WorktreeHandle, branch: string): Promise<WorktreeHandle> {
  await execFileP('git', ['checkout', '-B', branch], { cwd: handle.cwd })
  return { ...handle, branch }
}

/**
 * Scaffold an empty working directory when cloning is not viable (e.g. brand
 * new CodeCommit repo with no default branch yet). The agent will populate
 * files relative to `cwd`; we still produce an ScmFile[] from the resulting
 * tree.
 */
export async function scaffoldEmptyWorktree(runId: string): Promise<WorktreeHandle> {
  const cwd = await mkdtemp(path.join(tmpdir(), `orbital-run-${runId}-`))
  return { cwd, branch: 'main', defaultBranch: 'main' }
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage'])
const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB ceiling per file — protect daemon memory.

/**
 * Walk the worktree and return ScmFile[] entries for every regular file the
 * agent left behind, excluding `.git` and the usual build/cache dirs. Binary
 * files are emitted as base64; text files (UTF-8 valid) as content_utf8.
 */
export async function collectScmFiles(cwd: string): Promise<ScmFile[]> {
  const files: ScmFile[] = []
  await walk(cwd, cwd, files)
  return files
}

async function walk(root: string, current: string, out: ScmFile[]): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await walk(root, path.join(current, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    const abs = path.join(current, entry.name)
    const st = await stat(abs)
    if (st.size > MAX_FILE_BYTES) continue
    const buf = await readFile(abs)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (isProbablyBinary(buf)) {
      out.push({ path: rel, content_base64: buf.toString('base64') })
    } else {
      out.push({ path: rel, content_utf8: buf.toString('utf8') })
    }
  }
}

function isProbablyBinary(buf: Buffer): boolean {
  // NUL byte in the first 8 KB is the standard heuristic.
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export async function destroyWorktree(handle: WorktreeHandle | null): Promise<void> {
  if (!handle) return
  try {
    await rm(handle.cwd, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
}

export async function hasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd })
  return stdout.trim().length > 0
}
