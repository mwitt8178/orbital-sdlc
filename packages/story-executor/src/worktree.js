/**
 * worktree.js — per-run git worktree lifecycle.
 *
 * Each story run gets its own filesystem-isolated worktree under
 * `/tmp/orbital-runs/<run_id>` so concurrent runs cannot interfere.
 * The host repo's git history is shared (cheap copy-on-write of refs);
 * the working tree is exclusive to this run.
 *
 * Real, end-to-end. Calls real git binaries.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const RUN_ROOT = process.env.ORBITAL_RUN_ROOT ?? path.join(os.tmpdir(), 'orbital-runs')

async function git(args, cwd) {
  return execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
}

/**
 * Create a worktree for a run.
 *
 * @param {object} opts
 * @param {string} opts.runId        — unique run identifier (used as path)
 * @param {string} opts.repoDir      — existing local clone (host repo)
 * @param {string} opts.branch       — branch name to create or check out in the worktree
 * @param {string} [opts.baseBranch] — branch to fork from (default: main)
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
export async function createWorktree({ runId, repoDir, branch, baseBranch = 'main' }) {
  if (!runId) throw new Error('runId required')
  if (!repoDir) throw new Error('repoDir required')
  if (!branch) throw new Error('branch required')

  await fs.mkdir(RUN_ROOT, { recursive: true })
  const worktreePath = path.join(RUN_ROOT, runId)

  // Ensure the base branch exists locally and is up to date.
  try {
    await git(['fetch', 'origin', baseBranch, '--depth=1'], repoDir)
  } catch {
    // Offline / origin not reachable — keep going with whatever ref exists.
  }

  // Try to add a new branch worktree from the base; if branch already exists,
  // check it out in the worktree instead.
  try {
    await git(['worktree', 'add', '-b', branch, worktreePath, baseBranch], repoDir)
  } catch (err) {
    const msg = String(err?.stderr ?? err?.message ?? '')
    if (/already exists/.test(msg) || /is not a valid object/.test(msg)) {
      await git(['worktree', 'add', worktreePath, branch], repoDir)
    } else {
      throw err
    }
  }

  return { worktreePath, branch }
}

/**
 * Remove a worktree, force-discarding any uncommitted changes.
 */
export async function removeWorktree({ worktreePath, repoDir }) {
  if (!worktreePath || !repoDir) return
  try {
    await git(['worktree', 'remove', '--force', worktreePath], repoDir)
  } catch {
    // Fall back to manual cleanup; prune dangling refs.
    try {
      await fs.rm(worktreePath, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      await git(['worktree', 'prune'], repoDir)
    } catch {
      /* ignore */
    }
  }
}

export const _testing = { RUN_ROOT }
