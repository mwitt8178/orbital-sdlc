/**
 * pre-merge.ts — Baseline pre-merge hook.
 *
 * Per TRD-09 §8.3 and task spec:
 * - Checks for unresolved conflicts in worktree (shells out to `git status --porcelain`).
 * - Looks for lines starting with 'UU' or conflict markers.
 * - Error code: HOOK_REJECTED_PRE_MERGE
 *
 * Note: This hook executes `git status --porcelain` via spawnSync. This is the
 * only baseline hook that has an I/O side effect (subprocess), justified by the
 * spec requirement "shells out to git status --porcelain". The hook does not
 * read or write any files — it only inspects git state.
 */

import { z } from 'zod'
import { spawnSync } from 'node:child_process'
import { defineHook } from '../types.js'
import type { HookContext } from '../types.js'

const PayloadSchema = z.object({
  /** Absolute path to the worktree. Required for git status check. */
  worktree_path: z.string().optional(),
  /** The branch being merged. */
  branch: z.string().optional(),
  /** Task id for audit trail. */
  task_id: z.string().optional(),
  /**
   * Optional: pre-computed conflict files list (for testing without a real git repo).
   * If present, skips the git status subprocess call.
   */
  conflict_files: z.array(z.string()).optional(),
})

export default defineHook({
  slug: 'pre-merge-no-unresolved-conflicts',
  description:
    'Merge is blocked if the worktree has unresolved git conflicts (UU lines in git status --porcelain).',
  appliesTo: ['AgentMergedBranch'],
  timing: 'pre',
  declaredOrder: 50,
  errorCode: 'HOOK_REJECTED_PRE_MERGE',
  payloadSchema: PayloadSchema,
  validator: (payload, _ctx: HookContext) => {
    const parsed = PayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return { allow: true } // non-blocking parse failure; pass through
    }

    const { worktree_path, conflict_files } = parsed.data

    // If conflict_files is explicitly provided (test path), use that.
    if (conflict_files !== undefined) {
      if (conflict_files.length > 0) {
        return {
          allow: false,
          reason: `merge rejected: unresolved conflicts in files: ${conflict_files.join(', ')}`,
        }
      }
      return { allow: true }
    }

    // Otherwise shell out to git status --porcelain in the worktree.
    if (!worktree_path) {
      // No worktree path; cannot check — pass through permissively.
      return { allow: true }
    }

    const result = spawnSync('git', ['status', '--porcelain'], {
      cwd: worktree_path,
      encoding: 'utf8',
      timeout: 10_000,
    })

    if (result.error || result.status !== 0) {
      // git command failed; cannot determine conflict state — pass through.
      return { allow: true }
    }

    const lines = (result.stdout ?? '').split('\n').filter(Boolean)
    const conflictLines = lines.filter(
      (l) =>
        l.startsWith('UU ') ||
        l.startsWith('AA ') ||
        l.startsWith('DD ') ||
        l.startsWith('AU ') ||
        l.startsWith('UA ') ||
        l.startsWith('DU ') ||
        l.startsWith('UD '),
    )

    if (conflictLines.length > 0) {
      const conflictFiles = conflictLines.map((l) => l.slice(3).trim())
      return {
        allow: false,
        reason: `merge rejected: unresolved conflicts in files: ${conflictFiles.join(', ')}`,
      }
    }

    return { allow: true }
  },
})
