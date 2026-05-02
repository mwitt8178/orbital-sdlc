/**
 * StatusLabelMapper — assign each Monday status label to an Orbital state.
 *
 * Renders one row per label found on the chosen status column. Each row has
 * a dropdown of Orbital states. Labels not yet mapped show as 'unset' and
 * default to 'backlog' on confirm.
 */

import {
  ORBITAL_STATES,
  type BoardMappingView,
  type BoardSchemaView,
  type OrbitalState,
} from '../BoardTab.js'

interface StatusLabelMapperProps {
  schema: BoardSchemaView
  mapping: BoardMappingView | null
  onChange(next: BoardMappingView): void
}

export function StatusLabelMapper({
  schema,
  mapping,
  onChange,
}: StatusLabelMapperProps) {
  if (!mapping) return null

  if (!mapping.status_column_id) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Pick a status column above first to map its labels to Orbital states.
      </section>
    )
  }

  const statusCol = schema.status_columns.find(
    (c) => c.column_id === mapping.status_column_id,
  )

  if (!statusCol || statusCol.labels.length === 0) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        The selected status column has no labels parsed from settings. Verify the board column
        type — Orbital expects a Monday &ldquo;status&rdquo; (color) column.
      </section>
    )
  }

  const setLabelMapping = (label: string, state: OrbitalState) => {
    onChange({
      ...mapping,
      status_label_to_state: { ...mapping.status_label_to_state, [label]: state },
    })
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Status label → Orbital state</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Map each label on the chosen status column to one of Orbital&apos;s lifecycle states.
        </p>
      </header>
      <ul className="divide-y divide-slate-100">
        {statusCol.labels.map((lbl) => {
          const current = mapping.status_label_to_state[lbl.label] ?? 'backlog'
          return (
            <li
              key={`${lbl.id}-${lbl.label}`}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                {lbl.color ? (
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: lbl.color }}
                  />
                ) : null}
                <span className="text-sm text-slate-900">{lbl.label}</span>
              </div>
              <select
                value={current}
                onChange={(e) => setLabelMapping(lbl.label, e.target.value as OrbitalState)}
                className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {ORBITAL_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
