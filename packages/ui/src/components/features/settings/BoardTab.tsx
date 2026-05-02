/**
 * BoardTab — Round 5 Monday board discovery + mapping editor.
 *
 * Per Round 5 spec: instead of pushing a fixed canonical schema onto a
 * Monday board, Orbital learns the board's actual shape and lets the user
 * (or LLM) confirm the mapping between canonical SDLC concepts and the
 * board's real columns.
 *
 * Workflow:
 *   1. User selects a project (uses the active project from the store).
 *   2. "Discover" button calls boards.discover() — returns the BoardSchema
 *      and a heuristic/LLM-proposed BoardMapping.
 *   3. User reviews the schema in the SchemaBrowser, edits the mapping in
 *      the MappingEditor + StatusLabelMapper, and confirms.
 *   4. After confirmation, personas + MondaySyncService use the mapping.
 *
 * If no project is active, render a hint to pick a project first.
 * If the active project has no Monday board connected, render a hint to
 * connect one in the Projects page.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useActiveProjectStore } from '../../../store/active-project.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'
import { Badge } from '../../ui/Badge.js'
import { SchemaBrowser } from './board/SchemaBrowser.js'
import { MappingEditor } from './board/MappingEditor.js'
import { StatusLabelMapper } from './board/StatusLabelMapper.js'

// ---------------------------------------------------------------------------
// Types — kept in lockstep with the orchestrator types to avoid drift. We
// intentionally re-declare here rather than import from @orbital/orchestrator
// so the UI bundle stays type-only on tRPC + a few primitives.
// ---------------------------------------------------------------------------

export interface BoardColumnView {
  column_id: string
  title: string
  type: string
  settings: unknown
  sample_values: unknown[]
}

export interface BoardStatusLabelView {
  id: number
  label: string
  color: string
}

export interface BoardStatusColumnView {
  column_id: string
  labels: BoardStatusLabelView[]
}

export interface BoardSchemaView {
  board_id: string
  workspace_id: string
  board_name: string
  discovered_at: string
  columns: BoardColumnView[]
  status_columns: BoardStatusColumnView[]
  has_subitems: boolean
  subitem_columns?: BoardColumnView[]
  sample_items: Array<{ item_id: string; name: string; columns: Record<string, unknown> }>
  workflow_history: Array<{ from_state: string; to_state: string; count: number; avg_dwell_ms: number }>
}

export const ORBITAL_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'accepted',
  'defective',
] as const
export type OrbitalState = (typeof ORBITAL_STATES)[number]

export interface BoardMappingView {
  board_id: string
  project_id: string
  status_column_id: string | null
  status_label_to_state: Record<string, OrbitalState>
  estimate_column_id: string | null
  priority_column_id: string | null
  ac_column_id: string | null
  ac_subitem_template_id: string | null
  assignee_column_id: string | null
  story_points_unit: 'story_points' | 'hours' | 't_shirt' | 'none'
  monday_terminology: { epic: string; story: string; task: string; sprint: string }
  confirmed_at: string | null
  confirmed_by: string | null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BoardTab() {
  const activeProjectId = useActiveProjectStore((s) => s.activeProjectId)

  if (!activeProjectId) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Select an active project from the project picker (top of page) to discover and map its
        Monday board.
      </div>
    )
  }

  return <BoardTabBody projectId={activeProjectId} />
}

interface BoardTabBodyProps {
  projectId: string
}

function BoardTabBody({ projectId }: BoardTabBodyProps) {
  const project = trpc.projects.get.useQuery({ projectId })
  const existingMapping = trpc.boards.getMapping.useQuery({ project_id: projectId })
  const existingSchemaInputId = project.data?.mondayBoardId ?? ''
  const existingSchema = trpc.boards.getSchema.useQuery(
    { board_id: existingSchemaInputId },
    { enabled: existingSchemaInputId.length > 0 },
  )

  const utils = trpc.useUtils()
  const discover = trpc.boards.discover.useMutation({
    onSuccess: () => {
      void utils.boards.getMapping.invalidate({ project_id: projectId })
      void utils.boards.getSchema.invalidate()
    },
  })
  const confirm = trpc.boards.confirmMapping.useMutation({
    onSuccess: () => {
      void utils.boards.getMapping.invalidate({ project_id: projectId })
    },
  })

  // Working draft of the mapping. Initialised from the latest discover()
  // response if available; otherwise from any existing confirmed mapping.
  const [draft, setDraft] = useState<BoardMappingView | null>(null)
  const [schema, setSchema] = useState<BoardSchemaView | null>(null)

  // Hydrate state from existing data on first load + when a refresh completes.
  useEffect(() => {
    if (discover.data) {
      setSchema(discover.data.schema as BoardSchemaView)
      setDraft(discover.data.proposed_mapping as BoardMappingView)
      return
    }
    if (existingSchema.data) {
      setSchema(existingSchema.data.schema as BoardSchemaView)
    }
    if (existingMapping.data && draft === null) {
      setDraft(existingMapping.data as BoardMappingView)
    }
  }, [discover.data, existingSchema.data, existingMapping.data, draft])

  if (project.isLoading || existingMapping.isLoading) {
    return <Skeleton rows={6} />
  }
  if (project.error) {
    return <ErrorMessage title="Could not load project" message={project.error.message} />
  }

  const proj = project.data
  if (!proj) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
        Active project not found. Pick a different project.
      </div>
    )
  }

  if (!proj.mondayBoardId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        This project has no Monday board connected. Connect a board on the Projects page first.
      </div>
    )
  }

  const handleDiscover = () => {
    discover.mutate({ project_id: projectId })
  }

  const handleConfirm = () => {
    if (!draft) return
    confirm.mutate({
      project_id: projectId,
      mapping: draft,
    })
  }

  const confirmedMapping = existingMapping.data ?? null
  const isConfirmedNow = confirm.isSuccess
  const lastDiscoveredIso = schema?.discovered_at ?? existingSchema.data?.discovered_at ?? null

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Discovered board</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Orbital learns the shape of your Monday board so personas write to the correct columns.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDiscover}
            disabled={discover.isPending}
          >
            {discover.isPending ? 'Discovering…' : schema ? 'Re-discover' : 'Discover board'}
          </Button>
        </header>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <KV label="Project" value={proj.name} />
          <KV label="Monday board" value={schema?.board_name ?? proj.mondayBoardId} mono={!schema} />
          <KV label="Board ID" value={proj.mondayBoardId} mono />
          <KV
            label="Last discovered"
            value={lastDiscoveredIso ? new Date(lastDiscoveredIso).toLocaleString() : 'never'}
          />
          <KV
            label="Mapping status"
            valueElement={
              isConfirmedNow ? (
                <Badge color="emerald">Just confirmed</Badge>
              ) : confirmedMapping?.confirmed_at ? (
                <Badge color="emerald">Confirmed</Badge>
              ) : draft ? (
                <Badge color="amber">Pending confirmation</Badge>
              ) : (
                <Badge color="slate">Not configured</Badge>
              )
            }
          />
        </div>

        {discover.error && (
          <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            Discovery failed: {discover.error.message}
          </div>
        )}
        {confirm.error && (
          <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            Confirm failed: {confirm.error.message}
          </div>
        )}
      </section>

      {schema ? (
        <>
          <SchemaBrowser schema={schema} />
          <MappingEditor schema={schema} mapping={draft} onChange={setDraft} />
          <StatusLabelMapper schema={schema} mapping={draft} onChange={setDraft} />
          <section className="flex items-center justify-end gap-3">
            {isConfirmedNow && (
              <span className="text-xs text-emerald-700">
                Personas will use this mapping when interacting with Monday.
              </span>
            )}
            <Button
              variant="primary"
              size="md"
              onClick={handleConfirm}
              disabled={!draft || confirm.isPending}
            >
              {confirm.isPending ? 'Saving…' : 'Confirm mapping'}
            </Button>
          </section>
        </>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No schema discovered yet. Click &ldquo;Discover board&rdquo; to start.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Local KV helper (mirrors the one in IdentityTab; kept private here to avoid
// a shared-component refactor right now).
// ---------------------------------------------------------------------------

interface KVProps {
  label: string
  value?: string
  valueElement?: ReactNode
  mono?: boolean
}

function KV({ label, value, valueElement, mono }: KVProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      {valueElement ? (
        valueElement
      ) : (
        <span
          className={`truncate text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}
          title={value}
        >
          {value}
        </span>
      )}
    </div>
  )
}
