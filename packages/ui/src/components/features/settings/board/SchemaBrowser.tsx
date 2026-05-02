/**
 * SchemaBrowser — collapsible list of columns from a discovered BoardSchema.
 *
 * Renders the schema as a flat list grouped by column type, with a small
 * details affordance per column showing sample values.
 */

import { useState } from 'react'
import { Badge } from '../../../ui/Badge.js'
import type { BoardSchemaView, BoardColumnView } from '../BoardTab.js'

interface SchemaBrowserProps {
  schema: BoardSchemaView
}

export function SchemaBrowser({ schema }: SchemaBrowserProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Schema</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {schema.columns.length} columns · {schema.status_columns.length} status columns ·{' '}
            {schema.has_subitems ? 'has subitems' : 'no subitems'}
          </p>
        </div>
      </header>
      <ul className="divide-y divide-slate-100">
        {schema.columns.map((col) => (
          <ColumnRow key={col.column_id} column={col} />
        ))}
      </ul>
      {schema.subitem_columns && schema.subitem_columns.length > 0 ? (
        <div className="border-t border-slate-200">
          <header className="px-4 py-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Subitem columns
            </h4>
          </header>
          <ul className="divide-y divide-slate-100">
            {schema.subitem_columns.map((col) => (
              <ColumnRow key={col.column_id} column={col} subitem />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function ColumnRow({ column, subitem }: { column: BoardColumnView; subitem?: boolean }) {
  const [open, setOpen] = useState(false)
  const samples = column.sample_values.slice(0, 3)
  return (
    <li className="px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Badge color={badgeColorForType(column.type)}>{column.type}</Badge>
          <span className="truncate text-sm font-medium text-slate-900" title={column.title}>
            {column.title}
          </span>
          {subitem ? (
            <span className="text-xs text-slate-400">(subitem)</span>
          ) : null}
        </span>
        <code className="ml-2 flex-shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700">
          {column.column_id}
        </code>
      </button>
      {open ? (
        <div className="mt-2 rounded bg-slate-50 px-3 py-2">
          {samples.length === 0 ? (
            <p className="text-xs text-slate-500">No sample values seen.</p>
          ) : (
            <ol className="space-y-1">
              {samples.map((s, idx) => (
                <li
                  key={idx}
                  className="overflow-x-auto whitespace-pre font-mono text-[11px] text-slate-700"
                >
                  {formatSample(s)}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </li>
  )
}

function badgeColorForType(
  type: string,
): 'emerald' | 'blue' | 'violet' | 'amber' | 'rose' | 'slate' {
  switch (type) {
    case 'status':
      return 'emerald'
    case 'numbers':
    case 'date':
      return 'blue'
    case 'text':
    case 'long-text':
      return 'violet'
    case 'people':
      return 'amber'
    case 'formula':
    case 'mirror':
      return 'rose'
    default:
      return 'slate'
  }
}

function formatSample(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
