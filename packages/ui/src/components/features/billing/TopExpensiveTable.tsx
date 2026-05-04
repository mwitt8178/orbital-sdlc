/**
 * TopExpensiveTable — top N most expensive stories.
 *
 * Each row links to /stories/:storyId.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

import { Link } from 'react-router-dom'

interface Row {
  storyId: string
  costUsd: number
  entryCount: number
  firstAt: string
  lastAt: string
}

interface Props {
  rows: Row[]
}

export function TopExpensiveTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
        No story-level spend recorded yet.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-semibold">Story</th>
            <th className="px-4 py-2 text-right font-semibold">Cost</th>
            <th className="px-4 py-2 text-right font-semibold">Calls</th>
            <th className="px-4 py-2 text-right font-semibold">Last activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((r, i) => (
            <tr key={r.storyId} className="hover:bg-slate-50">
              <td className="px-4 py-2">
                <span className="mr-2 inline-block w-5 text-right font-mono text-xs text-slate-400">
                  #{i + 1}
                </span>
                <Link
                  to={`/stories/${r.storyId}`}
                  className="font-mono text-xs text-brand-700 underline-offset-2 hover:underline"
                >
                  {r.storyId.slice(0, 8)}…
                </Link>
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-900">
                ${r.costUsd.toFixed(4)}
              </td>
              <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-700">
                {r.entryCount}
              </td>
              <td className="px-4 py-2 text-right text-xs text-slate-500">
                {new Date(r.lastAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
