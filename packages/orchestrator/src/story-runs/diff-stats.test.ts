/**
 * diff-stats.test.ts — Reducer over ScmClient.getDifferences output.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 */

import { describe, it, expect } from 'vitest'
import { reduceDiffStats } from './diff-stats.js'
import type { ScmDifferenceFile } from '../scm/client.js'

describe('reduceDiffStats', () => {
  it('returns zeros for empty input', () => {
    expect(reduceDiffStats([])).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
  it('sums additions and deletions across files', () => {
    const files: ScmDifferenceFile[] = [
      { path: 'a.ts', oldBlob: '1', newBlob: '2', additions: 5, deletions: 1, changeType: 'M' },
      { path: 'b.ts', oldBlob: null, newBlob: '3', additions: 10, deletions: 0, changeType: 'A' },
      { path: 'c.ts', oldBlob: '4', newBlob: null, additions: 0, deletions: 7, changeType: 'D' },
    ]
    expect(reduceDiffStats(files)).toEqual({ files: 3, additions: 15, deletions: 8 })
  })
})
