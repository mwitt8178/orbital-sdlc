/**
 * diff-stats.ts — Reduce ScmClient.getDifferences output to UI-ready totals.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 */

import type { ScmDifferenceFile } from '../scm/client.js'

export interface ReducedDiffStats {
  files: number
  additions: number
  deletions: number
}

export function reduceDiffStats(files: readonly ScmDifferenceFile[]): ReducedDiffStats {
  let additions = 0
  let deletions = 0
  for (const f of files) {
    additions += f.additions
    deletions += f.deletions
  }
  return { files: files.length, additions, deletions }
}
