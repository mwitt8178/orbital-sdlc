/**
 * github-pr.js — wrap `gh` CLI for branch creation, push, PR open.
 *
 * Uses the authenticated user from `gh auth status`. The orbital repo's
 * in-tree GithubClient (packages/orchestrator/src/github/client.ts) is NOT
 * used here because (a) it requires @orbital/types + keychain that aren't
 * installed in this standalone executor, (b) `gh` uses the same identity and
 * scope (`repo`) so the network effect is identical, (c) staying out of the
 * orchestrator client keeps blast radius local to this package.
 *
 * Operations:
 *   ensureRepoExists(name)  — idempotent; creates if 404.
 *   pushBranch({ repoUrl, sandboxDir, branch })
 *   openPullRequest({ owner, repo, head, base, title, body })
 *
 * All operations shell out via execFile and check exit codes loudly.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export async function ghAuthenticatedUser() {
  const { stdout } = await execFileP('gh', ['api', 'user', '--jq', '.login'])
  return stdout.trim()
}

export async function ensureRepoExists({ owner, repo, description = '' }) {
  try {
    await execFileP('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'name'])
    return { created: false }
  } catch (err) {
    // 'gh repo view' returns non-zero on 404. Create.
    await execFileP('gh', [
      'repo',
      'create',
      `${owner}/${repo}`,
      '--private',
      '--description',
      description || `Orbital story-executor verification sandbox`,
      '--add-readme',
    ])
    return { created: true }
  }
}

export async function gitInitAndPush({ sandboxDir, repoUrl, branch, commitMessage }) {
  // Init repo, set remote, fetch base, branch, commit, push.
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: sandboxDir })
  await execFileP('git', ['config', 'user.email', 'orbital-executor@noreply.local'], { cwd: sandboxDir })
  await execFileP('git', ['config', 'user.name', 'Orbital Story Executor'], { cwd: sandboxDir })
  await execFileP('git', ['remote', 'add', 'origin', repoUrl], { cwd: sandboxDir })
  // Fetch the initial main commit (the README the gh repo create added).
  await execFileP('git', ['fetch', 'origin', 'main'], { cwd: sandboxDir })
  await execFileP('git', ['reset', '--hard', 'origin/main'], { cwd: sandboxDir })
  // The worker has already written files into sandboxDir on top of nothing;
  // since we just reset, re-apply by loading the staged files from a snapshot
  // — but we structured the executor to write the worker's files AFTER this
  // setup. Caller controls ordering; this function only sets up the repo
  // skeleton. See main.js orchestration.
}

export async function commitAndPush({ sandboxDir, branch, commitMessage }) {
  await execFileP('git', ['checkout', '-b', branch], { cwd: sandboxDir })
  await execFileP('git', ['add', '-A'], { cwd: sandboxDir })
  await execFileP('git', ['commit', '-m', commitMessage], { cwd: sandboxDir })
  await execFileP('git', ['push', '-u', 'origin', branch], { cwd: sandboxDir })
}

export async function openPullRequest({ owner, repo, head, base, title, body }) {
  // gh pr create writes the URL to stdout on success.
  const { stdout } = await execFileP(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      `${owner}/${repo}`,
      '--head',
      head,
      '--base',
      base,
      '--title',
      title,
      '--body',
      body,
    ],
  )
  return { url: stdout.trim() }
}
