/**
 * ReplayDiff — side-by-side comparison between recorded and replayed responses.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Two columns:
 *   - "Recorded" — the canonical-JSON of the response captured at original run
 *   - "Replay"   — the canonical-JSON of the response from the replay invocation
 *
 * A "Diff lines" toggle surfaces a unified text diff highlighting added /
 * removed / changed lines so the operator can see where determinism broke.
 */

import { useMemo, useState } from 'react'

interface ReplayDiffProps {
  recorded: Record<string, unknown> | null
  replay: Record<string, unknown> | null
  matchedHash: boolean
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, sortedReplacer, 2)
}

function sortedReplacer(_key: string, val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
  const obj = val as Record<string, unknown>
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k]
      return acc
    }, {})
}

/**
 * Compute a simple line-level diff between two strings. We use LCS so the
 * output mirrors a unified diff. For small JSON payloads this is plenty.
 */
function diffLines(a: string, b: string): Array<{ kind: 'eq' | 'add' | 'del'; text: string }> {
  const aL = a.split('\n')
  const bL = b.split('\n')
  const n = aL.length
  const m = bL.length
  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aL[i] === bL[j]) dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1
      else dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const out: Array<{ kind: 'eq' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aL[i] === bL[j]) {
      out.push({ kind: 'eq', text: aL[i]! })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: aL[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: bL[j]! })
      j++
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: aL[i++]! })
  }
  while (j < m) {
    out.push({ kind: 'add', text: bL[j++]! })
  }
  return out
}

export function ReplayDiff({ recorded, replay, matchedHash }: ReplayDiffProps) {
  const [showDiff, setShowDiff] = useState(false)

  const recordedJson = useMemo(() => canonicalJSON(recorded ?? {}), [recorded])
  const replayJson = useMemo(() => canonicalJSON(replay ?? {}), [replay])
  const lines = useMemo(() => diffLines(recordedJson, replayJson), [recordedJson, replayJson])

  return (
    <div className="space-y-3" data-testid="replay-diff">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
              matchedHash
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-amber-50 text-amber-700'
            }`}
          >
            {matchedHash ? 'Hash match' : 'Hash drift'}
          </span>
          <span className="text-slate-500">
            {matchedHash
              ? 'Replay produced byte-identical output.'
              : 'Replay differs from recorded output.'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowDiff((v) => !v)}
          className="text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          {showDiff ? 'Side-by-side' : 'Diff lines'}
        </button>
      </div>

      {showDiff ? (
        <pre className="max-h-96 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
          {lines.map((l, idx) => (
            <span
              key={idx}
              className={`block ${
                l.kind === 'add'
                  ? 'bg-emerald-100 text-emerald-900'
                  : l.kind === 'del'
                    ? 'bg-rose-100 text-rose-900'
                    : 'text-slate-700'
              }`}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </span>
          ))}
        </pre>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">Recorded</div>
            <pre className="max-h-96 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {recordedJson}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">Replay</div>
            <pre className="max-h-96 overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {replay === null ? '(inspect mode — no replay run)' : replayJson}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
