/**
 * MappingEditor — pick which Monday column maps to each canonical SDLC concept.
 *
 * Side-by-side layout:
 *   left:  canonical concept name (status, estimate, priority, AC, assignee)
 *   right: dropdown of columns from the schema (filtered by valid types)
 *
 * Edits are surfaced via onChange — the parent owns the draft mapping and
 * persists on confirm.
 */

import type { BoardSchemaView, BoardColumnView, BoardMappingView } from '../BoardTab.js'

interface MappingEditorProps {
  schema: BoardSchemaView
  mapping: BoardMappingView | null
  onChange(next: BoardMappingView): void
}

export function MappingEditor({ schema, mapping, onChange }: MappingEditorProps) {
  if (!mapping) return null

  const setField = <K extends keyof BoardMappingView>(
    key: K,
    value: BoardMappingView[K],
  ) => {
    onChange({ ...mapping, [key]: value })
  }

  const setTerminology = (
    key: keyof BoardMappingView['monday_terminology'],
    value: string,
  ) => {
    onChange({
      ...mapping,
      monday_terminology: { ...mapping.monday_terminology, [key]: value },
    })
  }

  const statusCols = schema.columns.filter((c) => c.type === 'status')
  const numberCols = schema.columns.filter((c) => c.type === 'numbers')
  const longTextCols = schema.columns.filter((c) => c.type === 'long-text' || c.type === 'text')
  const peopleCols = schema.columns.filter((c) => c.type === 'people')
  const priorityCandidates = schema.columns.filter(
    (c) => c.type === 'status' || c.type === 'dropdown',
  )

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Mapping</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Pick which Monday column drives each canonical concept. The personas read this mapping at
          runtime so writes go to the correct column.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-2">
        <ColumnPicker
          label="Status (lifecycle)"
          help="The column whose label drives backlog → in_progress → done."
          options={statusCols}
          value={mapping.status_column_id}
          onChange={(v) => setField('status_column_id', v)}
        />
        <ColumnPicker
          label="Estimate"
          help="The numeric column for story points, hours, or t-shirt size."
          options={numberCols}
          value={mapping.estimate_column_id}
          onChange={(v) => setField('estimate_column_id', v)}
        />
        <UnitPicker
          value={mapping.story_points_unit}
          onChange={(v) => setField('story_points_unit', v)}
        />
        <ColumnPicker
          label="Priority"
          help="A status or dropdown column that signals priority."
          options={priorityCandidates}
          value={mapping.priority_column_id}
          onChange={(v) => setField('priority_column_id', v)}
        />
        <ColumnPicker
          label="Assignee"
          help="The people column."
          options={peopleCols}
          value={mapping.assignee_column_id}
          onChange={(v) => setField('assignee_column_id', v)}
        />
        <ACSourcePicker
          schema={schema}
          longTextCols={longTextCols}
          mapping={mapping}
          onChange={onChange}
        />
      </div>

      <div className="border-t border-slate-100 px-4 py-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Vocabulary
        </h4>
        <p className="mt-0.5 text-xs text-slate-500">
          What does this team call these objects? Persona prompts use the team&apos;s own words.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          {(['epic', 'story', 'task', 'sprint'] as const).map((k) => (
            <label key={k} className="block">
              <span className="text-xs text-slate-500">{k}</span>
              <input
                type="text"
                value={mapping.monday_terminology[k]}
                onChange={(e) => setTerminology(k, e.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Sub-pickers
// ---------------------------------------------------------------------------

interface ColumnPickerProps {
  label: string
  help: string
  options: BoardColumnView[]
  value: string | null
  onChange(next: string | null): void
}

function ColumnPicker({ label, help, options, value, onChange }: ColumnPickerProps) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-900">{label}</span>
      <span className="mt-0.5 block text-xs text-slate-500">{help}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      >
        <option value="">— none —</option>
        {options.map((c) => (
          <option key={c.column_id} value={c.column_id}>
            {c.title} ({c.column_id})
          </option>
        ))}
      </select>
    </label>
  )
}

interface UnitPickerProps {
  value: BoardMappingView['story_points_unit']
  onChange(next: BoardMappingView['story_points_unit']): void
}

function UnitPicker({ value, onChange }: UnitPickerProps) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-900">Estimate unit</span>
      <span className="mt-0.5 block text-xs text-slate-500">
        How is the estimate column interpreted?
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BoardMappingView['story_points_unit'])}
        className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      >
        <option value="story_points">Story points</option>
        <option value="hours">Hours</option>
        <option value="t_shirt">T-shirt sizes</option>
        <option value="none">None</option>
      </select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// AC source — column OR subitem (mutually exclusive)
// ---------------------------------------------------------------------------

interface ACSourcePickerProps {
  schema: BoardSchemaView
  longTextCols: BoardColumnView[]
  mapping: BoardMappingView
  onChange(next: BoardMappingView): void
}

function ACSourcePicker({
  schema,
  longTextCols,
  mapping,
  onChange,
}: ACSourcePickerProps) {
  const kind: 'column' | 'subitem' | 'none' = mapping.ac_subitem_template_id
    ? 'subitem'
    : mapping.ac_column_id
      ? 'column'
      : 'none'

  const setKind = (k: 'column' | 'subitem' | 'none') => {
    if (k === 'none') {
      onChange({ ...mapping, ac_column_id: null, ac_subitem_template_id: null })
      return
    }
    if (k === 'column') {
      onChange({
        ...mapping,
        ac_subitem_template_id: null,
        ac_column_id: longTextCols[0]?.column_id ?? null,
      })
      return
    }
    // subitem
    const firstSubitemTextCol = schema.subitem_columns?.find(
      (c) => c.type === 'text' || c.type === 'long-text',
    )
    onChange({
      ...mapping,
      ac_column_id: null,
      ac_subitem_template_id: firstSubitemTextCol?.column_id ?? 'name',
    })
  }

  return (
    <div className="md:col-span-2 rounded border border-slate-200 px-3 py-3">
      <div className="text-sm font-medium text-slate-900">Acceptance Criteria source</div>
      <p className="mt-0.5 text-xs text-slate-500">
        Where does each story&apos;s AC live on this board?
      </p>
      <div className="mt-2 flex gap-3 text-sm">
        {(['column', 'subitem', 'none'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="ac-source"
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            <span className="capitalize">{k === 'column' ? 'Column' : k === 'subitem' ? 'Subitems' : 'None'}</span>
          </label>
        ))}
      </div>
      {kind === 'column' && (
        <select
          value={mapping.ac_column_id ?? ''}
          onChange={(e) =>
            onChange({
              ...mapping,
              ac_column_id: e.target.value === '' ? null : e.target.value,
            })
          }
          className="mt-2 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">— pick a long-text column —</option>
          {longTextCols.map((c) => (
            <option key={c.column_id} value={c.column_id}>
              {c.title} ({c.column_id})
            </option>
          ))}
        </select>
      )}
      {kind === 'subitem' && (
        <div className="mt-2">
          {schema.has_subitems ? (
            <select
              value={mapping.ac_subitem_template_id ?? ''}
              onChange={(e) =>
                onChange({
                  ...mapping,
                  ac_subitem_template_id: e.target.value === '' ? null : e.target.value,
                })
              }
              className="block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="name">— subitem name itself is the AC —</option>
              {(schema.subitem_columns ?? [])
                .filter((c) => c.type === 'text' || c.type === 'long-text')
                .map((c) => (
                  <option key={c.column_id} value={c.column_id}>
                    {c.title} ({c.column_id})
                  </option>
                ))}
            </select>
          ) : (
            <p className="text-xs text-amber-700">
              This board does not have subitems enabled. Add them in Monday or pick a column instead.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
