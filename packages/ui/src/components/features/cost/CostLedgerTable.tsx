/**
 * CostLedgerTable — sortable, paginated table of cost_ledger rows.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'

interface CostLedgerTableProps {
  projectId: string
  sprintId?: string
  taskId?: string
}

type SortKey = 'costUsd' | 'occurredAt' | 'personaId' | 'model'
type SortDir = 'asc' | 'desc'

export function CostLedgerTable({ projectId, sprintId, taskId }: CostLedgerTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('occurredAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [cursor, setCursor] = useState<string | undefined>(undefined)

  const query = trpc.cost.ledger.useQuery({
    projectId,
    sprintId,
    taskId,
    limit: 50,
    cursor,
  })

  const rows = [...(query.data?.rows ?? [])].sort((a, b) => {
    let va: string | number = a[sortKey] ?? ''
    let vb: string | number = b[sortKey] ?? ''
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortDir === 'desc' ? vb - va : va - vb
    }
    va = String(va)
    vb = String(vb)
    return sortDir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb)
  })

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const thClass = (key: SortKey) =>
    `cursor-pointer select-none px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-900 ${sortKey === key ? 'text-brand-600' : ''}`

  if (query.isLoading) {
    return <div className="py-8 text-center text-sm text-slate-400">Loading cost data…</div>
  }

  if (query.isError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        Failed to load cost data: {query.error.message}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        No cost entries yet. LLM calls will appear here once workers are running.
      </div>
    )
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className={thClass('occurredAt')} onClick={() => toggleSort('occurredAt')}>
                Time {sortKey === 'occurredAt' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                Task
              </th>
              <th className={thClass('personaId')} onClick={() => toggleSort('personaId')}>
                Persona {sortKey === 'personaId' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
              <th className={thClass('model')} onClick={() => toggleSort('model')}>
                Model {sortKey === 'model' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
                In tokens
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
                Out tokens
              </th>
              <th
                className={thClass('costUsd') + ' text-right'}
                onClick={() => toggleSort('costUsd')}
              >
                Cost USD {sortKey === 'costUsd' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r) => (
              <tr key={r.entryId} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                  {new Date(r.occurredAt).toLocaleString()}
                </td>
                <td className="max-w-[120px] truncate px-3 py-2 font-mono text-xs text-slate-500">
                  {r.taskId ? r.taskId.slice(0, 8) + '…' : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {r.personaId ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {r.model}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
                  {r.inputTokens.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
                  {r.outputTokens.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-900">
                  ${r.costUsd.toFixed(6)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {query.data?.nextCursor && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setCursor(query.data.nextCursor ?? undefined)}
            className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  )
}
