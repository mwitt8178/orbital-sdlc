/**
 * scm/unified-diff.ts — Self-contained line-level unified-diff utility.
 *
 * [Engineer-Principal · Opus · run-phase-e-review-ui-codecommit]
 *
 * Used by CodeCommit's getUnifiedDiff to convert before/after blob text
 * into hunks that the UI can render directly. We deliberately avoid
 * pulling in a third-party diff library to keep the api-lambda bundle
 * lean and the security surface tight.
 *
 * Algorithm: classic Hunt-McIlroy LCS over lines, then walk the LCS to
 * emit '+', '-', ' ' tokens. Hunks are produced by grouping non-context
 * tokens together with up to `context` lines of surrounding context.
 *
 * For files larger than ~MAX_LINES this falls back to a "replace whole
 * file" hunk to avoid quadratic blowup. The UI still renders a useful
 * before/after comparison for the few pathological cases.
 */
import type { ScmUnifiedHunk, ScmUnifiedHunkLine } from './client.js'

const DEFAULT_CONTEXT = 3
/** LCS is O(n*m); cap to avoid runaway lambda CPU. */
const MAX_LINES = 5000

export interface UnifiedDiffResult {
  hunks: ScmUnifiedHunk[]
  additions: number
  deletions: number
  binary: boolean
}

export function computeUnifiedDiff(
  oldText: string | null,
  newText: string | null,
  context: number = DEFAULT_CONTEXT,
): UnifiedDiffResult {
  // Binary heuristic: presence of NUL byte in either side.
  if ((oldText && oldText.includes('\u0000')) || (newText && newText.includes('\u0000'))) {
    return { hunks: [], additions: 0, deletions: 0, binary: true }
  }

  const oldLines = oldText === null || oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === null || newText === '' ? [] : newText.split('\n')
  // Trailing newline produces a phantom empty line — drop it on both sides
  // for diff purposes. The UI hint about missing newlines is out of scope.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop()
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop()

  // Pure add or pure delete fast paths.
  if (oldLines.length === 0 && newLines.length === 0) {
    return { hunks: [], additions: 0, deletions: 0, binary: false }
  }
  if (oldLines.length === 0) {
    return {
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: newLines.length,
          lines: newLines.map<ScmUnifiedHunkLine>((c) => ({ origin: '+', content: c })),
        },
      ],
      additions: newLines.length,
      deletions: 0,
      binary: false,
    }
  }
  if (newLines.length === 0) {
    return {
      hunks: [
        {
          oldStart: 1,
          oldLines: oldLines.length,
          newStart: 0,
          newLines: 0,
          lines: oldLines.map<ScmUnifiedHunkLine>((c) => ({ origin: '-', content: c })),
        },
      ],
      additions: 0,
      deletions: oldLines.length,
      binary: false,
    }
  }

  // Cap pathological inputs.
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    return {
      hunks: [
        {
          oldStart: 1,
          oldLines: oldLines.length,
          newStart: 1,
          newLines: newLines.length,
          lines: [
            ...oldLines.map<ScmUnifiedHunkLine>((c) => ({ origin: '-', content: c })),
            ...newLines.map<ScmUnifiedHunkLine>((c) => ({ origin: '+', content: c })),
          ],
        },
      ],
      additions: newLines.length,
      deletions: oldLines.length,
      binary: false,
    }
  }

  const ops = lcsOps(oldLines, newLines)
  const hunks = groupOpsIntoHunks(ops, context)
  let additions = 0
  let deletions = 0
  for (const op of ops) {
    if (op.origin === '+') additions++
    else if (op.origin === '-') deletions++
  }
  return { hunks, additions, deletions, binary: false }
}

interface DiffOp {
  origin: ' ' | '+' | '-'
  oldLine?: number // 1-based old-side line number
  newLine?: number // 1-based new-side line number
  content: string
}

function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  // Backtrack
  const ops: DiffOp[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ origin: ' ', oldLine: i, newLine: j, content: a[i - 1]! })
      i--
      j--
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ origin: '-', oldLine: i, content: a[i - 1]! })
      i--
    } else {
      ops.push({ origin: '+', newLine: j, content: b[j - 1]! })
      j--
    }
  }
  while (i > 0) {
    ops.push({ origin: '-', oldLine: i, content: a[i - 1]! })
    i--
  }
  while (j > 0) {
    ops.push({ origin: '+', newLine: j, content: b[j - 1]! })
    j--
  }
  ops.reverse()
  return ops
}

function groupOpsIntoHunks(ops: DiffOp[], context: number): ScmUnifiedHunk[] {
  const hunks: ScmUnifiedHunk[] = []
  let i = 0
  while (i < ops.length) {
    // Find next change.
    while (i < ops.length && ops[i]!.origin === ' ') i++
    if (i >= ops.length) break

    // Hunk start: back up `context` context lines.
    const start = Math.max(0, i - context)

    // Walk forward through changes + trailing context, joining to the next
    // change cluster if it falls within `2 * context` lines.
    let end = i
    while (end < ops.length) {
      if (ops[end]!.origin !== ' ') {
        end++
        continue
      }
      // Look ahead for another change within `2 * context` context lines.
      let runEnd = end
      while (runEnd < ops.length && ops[runEnd]!.origin === ' ') runEnd++
      if (runEnd >= ops.length) break
      if (runEnd - end > 2 * context) break
      end = runEnd
    }
    // Trim trailing context to `context` lines.
    let trailingContextEnd = end
    let trailing = 0
    while (trailingContextEnd < ops.length && ops[trailingContextEnd]!.origin === ' ' && trailing < context) {
      trailingContextEnd++
      trailing++
    }

    const slice = ops.slice(start, trailingContextEnd)
    const firstOldLine = slice.find((o) => o.oldLine !== undefined)?.oldLine
    const firstNewLine = slice.find((o) => o.newLine !== undefined)?.newLine
    const oldCount = slice.filter((o) => o.origin !== '+').length
    const newCount = slice.filter((o) => o.origin !== '-').length
    hunks.push({
      oldStart: firstOldLine ?? 0,
      oldLines: oldCount,
      newStart: firstNewLine ?? 0,
      newLines: newCount,
      lines: slice.map((o) => ({ origin: o.origin, content: o.content })),
    })

    i = trailingContextEnd
  }
  return hunks
}
