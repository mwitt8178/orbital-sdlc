/**
 * backlog/board-discovery.ts — BoardDiscoveryService.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * Responsibilities:
 *   - Call Monday GraphQL to introspect a board's actual shape (columns,
 *     subitem schema, sample items, top-level status labels).
 *   - Return a BoardSchema describing what was found.
 *
 * The discoverer makes ONE GraphQL call covering everything we need:
 *   - boards(ids: $boardId) { id, name, columns { id, title, type, settings_str },
 *       items_page(limit: 10) { items { id, name, column_values { ... } } } }
 *
 * Subitems are introspected via a sample item's subitems edge when present.
 *
 * No mutation. Pure read against the Monday API. Errors surface as
 * INTEGRATION_MONDAY_DOWN / INTEGRATION_MONDAY_AUTH from the underlying
 * MondayClient (we reuse the same retry/backoff pipeline).
 *
 * NOTE: We do NOT reuse the high-level MondayClient.getBoardItems here,
 * because that method only returns items + column_values. Discovery requires
 * the column metadata (id, title, type, settings_str) which getBoardItems
 * doesn't expose. Instead, we share the same authenticated GraphQL pipeline
 * by reaching into the client's underlying fetch via a dedicated extension
 * method (introspect()) that calls a custom query. To keep MondayClient's
 * surface area small, the introspection query is colocated here and dispatched
 * via the new MondayClient.graphql() helper exposed for this purpose.
 */

import type { MondayClient } from './monday-client.js'

// ---------------------------------------------------------------------------
// BoardSchema — public interface
// ---------------------------------------------------------------------------

/**
 * Canonical column types we recognise for mapping. Monday's `type` field is
 * usually one of: 'color' (status), 'numeric', 'text', 'long-text', 'date',
 * 'people', 'multiple-person', 'tags', 'dropdown', 'formula', 'mirror',
 * 'link'. Anything else falls into 'other'.
 */
export type BoardColumnType =
  | 'status'
  | 'text'
  | 'long-text'
  | 'date'
  | 'people'
  | 'dropdown'
  | 'numbers'
  | 'tags'
  | 'formula'
  | 'mirror'
  | 'link'
  | 'other'

export interface BoardColumn {
  column_id: string
  title: string
  type: BoardColumnType
  /** Raw settings_str object (parsed) from Monday — opaque to callers. */
  settings: unknown
  /** Top-N distinct sample values seen in items_page. Useful for hints. */
  sample_values: unknown[]
}

export interface BoardStatusLabel {
  id: number
  label: string
  color: string
}

export interface BoardStatusColumn {
  column_id: string
  labels: BoardStatusLabel[]
}

export interface BoardSampleItem {
  item_id: string
  name: string
  /** column_id → raw monday value object */
  columns: Record<string, unknown>
}

export interface BoardWorkflowEdge {
  from_state: string
  to_state: string
  count: number
  avg_dwell_ms: number
}

export interface BoardSchema {
  board_id: string
  /** Workspace id from Monday (may be empty if board not in workspace). */
  workspace_id: string
  /** Display name of the board. */
  board_name: string
  discovered_at: string
  columns: BoardColumn[]
  /**
   * Convenience subset: every column with type='status', along with its
   * parsed labels. Mapping UI uses this directly.
   */
  status_columns: BoardStatusColumn[]
  has_subitems: boolean
  /** Same shape as `columns` but for the subitem board. */
  subitem_columns?: BoardColumn[]
  /** First 5–10 items as sample data for the mapping LLM/heuristic. */
  sample_items: BoardSampleItem[]
  /**
   * Optional workflow history derived from item activity logs. Empty when not
   * supported or when the activity log API isn't available.
   */
  workflow_history: BoardWorkflowEdge[]
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BoardDiscoveryService {
  discover(boardId: string): Promise<BoardSchema>
}

// ---------------------------------------------------------------------------
// MondayClient extension contract
// ---------------------------------------------------------------------------

/**
 * MondayClient implementations that support introspection expose this method.
 * The default DefaultMondayClient does — see monday-client.ts.
 */
export interface MondayIntrospectClient extends MondayClient {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>
}

function hasGraphql(client: MondayClient): client is MondayIntrospectClient {
  return typeof (client as MondayIntrospectClient).graphql === 'function'
}

// ---------------------------------------------------------------------------
// Raw GraphQL response shape (what Monday returns)
// ---------------------------------------------------------------------------

interface RawColumn {
  id: string
  title: string
  type: string
  settings_str?: string
}

interface RawColumnValue {
  id: string
  value: string | null
  type: string | null
}

interface RawItem {
  id: string
  name: string
  column_values: RawColumnValue[]
}

interface RawSubitemBoard {
  id: string
  columns: RawColumn[]
}

interface RawBoard {
  id: string
  name: string
  workspace_id: string | number | null
  columns: RawColumn[]
  items_page?: { items: RawItem[] }
  /**
   * Monday exposes the subitem schema via boards(ids:$id) { items_page { items
   * { board { id, columns { ... } } } } } when an item has subitems. We probe
   * via the dedicated subitems_board field if available; otherwise we read the
   * first sample item's subitem column.
   */
  subitems_board?: RawSubitemBoard | null
}

// ---------------------------------------------------------------------------
// Introspection query
// ---------------------------------------------------------------------------

/**
 * Single GraphQL call that covers:
 *   - board metadata (id, name, workspace_id)
 *   - columns with settings_str
 *   - up to 10 sample items with their column_values
 *
 * We do NOT pull subitem board schema in the same query because Monday's
 * subitems schema is exposed differently across API versions. We make a
 * second call only if the sample items show a `subtasks` / `subitems` column.
 */
const INTROSPECT_QUERY = `
  query IntrospectBoard($boardId: [ID!]!) {
    boards(ids: $boardId) {
      id
      name
      workspace_id
      columns {
        id
        title
        type
        settings_str
      }
      items_page(limit: 10) {
        items {
          id
          name
          column_values {
            id
            value
            type
          }
        }
      }
    }
  }
`

/**
 * Subitems probe — Monday allows `subitems` to be queried per item; the
 * `board` of a subitem returns its column schema. We only call this if the
 * board's items show a column of type 'subtasks'.
 */
const SUBITEMS_PROBE_QUERY = `
  query ProbeSubitems($itemId: [ID!]!) {
    items(ids: $itemId) {
      id
      subitems {
        id
        board {
          id
          columns {
            id
            title
            type
            settings_str
          }
        }
      }
    }
  }
`

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface DefaultBoardDiscoveryServiceOptions {
  /** Maximum sample value count per column. Default 5. */
  maxSampleValuesPerColumn?: number
}

export class DefaultBoardDiscoveryService implements BoardDiscoveryService {
  private readonly maxSampleValuesPerColumn: number

  constructor(
    private readonly client: MondayClient,
    options: DefaultBoardDiscoveryServiceOptions = {},
  ) {
    this.maxSampleValuesPerColumn = options.maxSampleValuesPerColumn ?? 5
  }

  async discover(boardId: string): Promise<BoardSchema> {
    if (!hasGraphql(this.client)) {
      throw new Error(
        'BoardDiscoveryService: MondayClient does not expose graphql(). ' +
          'Use DefaultMondayClient (which does) or a test surrogate that implements MondayIntrospectClient.',
      )
    }

    const data = await this.client.graphql<{ boards: RawBoard[] }>(INTROSPECT_QUERY, {
      boardId: [boardId],
    })
    const raw = data.boards[0]
    if (!raw) {
      throw new Error(`BoardDiscoveryService: Monday returned no board for id ${boardId}`)
    }

    const items = raw.items_page?.items ?? []

    // Build the columns array, attaching sample values.
    const columns = raw.columns.map((rc) => this.buildColumn(rc, items))

    // Status columns: subset where type === 'status', with parsed labels.
    const statusColumns = columns
      .filter((c) => c.type === 'status')
      .map((c) => ({
        column_id: c.column_id,
        labels: parseStatusLabels(c.settings),
      }))

    // Detect subitems: a board column with type === 'subtasks' is the typical
    // Monday signal that this board uses subitems.
    const hasSubitems = raw.columns.some((c) => c.type === 'subtasks')
    let subitemColumns: BoardColumn[] | undefined
    if (hasSubitems && items.length > 0) {
      try {
        // Probe with the first sample item that has any subitem indication;
        // if no sample, just probe with the first item id.
        const probeId = items[0]!.id
        const probe = await (this.client as MondayIntrospectClient).graphql<{
          items: Array<{
            id: string
            subitems: Array<{ id: string; board: RawSubitemBoard | null }>
          }>
        }>(SUBITEMS_PROBE_QUERY, { itemId: [probeId] })
        const subitemBoardCols = probe.items[0]?.subitems[0]?.board?.columns ?? []
        if (subitemBoardCols.length > 0) {
          subitemColumns = subitemBoardCols.map((rc) => this.buildColumn(rc, []))
        }
      } catch {
        // Subitems probe is best-effort; it does NOT fail the discovery call.
        // We still surface has_subitems=true so the mapping can request
        // subitem-based AC.
      }
    }

    const sampleItems: BoardSampleItem[] = items.map((it) => ({
      item_id: it.id,
      name: it.name,
      columns: rawColumnValuesToObject(it.column_values),
    }))

    const result: BoardSchema = {
      board_id: String(raw.id),
      workspace_id: raw.workspace_id !== null && raw.workspace_id !== undefined ? String(raw.workspace_id) : '',
      board_name: raw.name,
      discovered_at: new Date().toISOString(),
      columns,
      status_columns: statusColumns,
      has_subitems: hasSubitems,
      sample_items: sampleItems,
      workflow_history: [], // deferred — activity logs require a separate API surface
    }
    if (subitemColumns) {
      result.subitem_columns = subitemColumns
    }
    return result
  }

  private buildColumn(rc: RawColumn, items: RawItem[]): BoardColumn {
    const type = mapMondayTypeToCanonical(rc.type)
    const settings = parseSettingsStr(rc.settings_str)
    const sampleValues = collectSampleValues(rc.id, items, this.maxSampleValuesPerColumn)
    return {
      column_id: rc.id,
      title: rc.title,
      type,
      settings,
      sample_values: sampleValues,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Map a raw Monday column type string to our BoardColumnType enum.
 *
 * Monday uses several aliases in the wild ('color' for what the docs call
 * 'status'; 'numbers' and 'numeric' both appear; 'long_text' vs 'long-text').
 * We normalise to a small canonical set.
 */
export function mapMondayTypeToCanonical(raw: string | null | undefined): BoardColumnType {
  if (!raw) return 'other'
  const t = raw.toLowerCase().replace(/_/g, '-')
  switch (t) {
    case 'status':
    case 'color':
    case 'color-picker':
      return 'status'
    case 'text':
      return 'text'
    case 'long-text':
    case 'long-text-column':
      return 'long-text'
    case 'date':
    case 'date-column':
    case 'timeline':
      return 'date'
    case 'people':
    case 'multiple-person':
    case 'multi-person':
    case 'person':
      return 'people'
    case 'dropdown':
      return 'dropdown'
    case 'numbers':
    case 'numeric':
      return 'numbers'
    case 'tags':
      return 'tags'
    case 'formula':
      return 'formula'
    case 'mirror':
    case 'lookup':
      return 'mirror'
    case 'link':
    case 'url':
      return 'link'
    default:
      return 'other'
  }
}

/**
 * Parse Monday's settings_str field. Monday returns the JSON as a string
 * (not pre-parsed), so we JSON.parse defensively. Returns an empty object on
 * parse failure so callers always see a record-like value.
 */
export function parseSettingsStr(s: string | null | undefined): unknown {
  if (!s || s.length === 0) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * Parse status-column settings into a flat label list.
 *
 * Monday's status settings shape (typical):
 *   { "labels": { "0": "Working on it", "1": "Done", ... },
 *     "labels_colors": { "0": { "color": "#fdab3d", ... }, ... } }
 * Some tenants expose `labels` as { id, name, color } objects; we tolerate
 * both forms.
 */
export function parseStatusLabels(settings: unknown): BoardStatusLabel[] {
  if (typeof settings !== 'object' || settings === null) return []
  const s = settings as { labels?: unknown; labels_colors?: unknown }

  const labels = s.labels
  if (!labels) return []

  // Form 1: { "0": "Working on it", "1": "Done", ... }
  if (isStringMap(labels)) {
    const colors = (s.labels_colors ?? {}) as Record<string, { color?: string } | undefined>
    return Object.entries(labels).map(([id, label]) => {
      const numId = Number.parseInt(id, 10)
      const color = colors[id]?.color ?? ''
      return {
        id: Number.isFinite(numId) ? numId : 0,
        label: String(label),
        color,
      }
    })
  }

  // Form 2: array of objects { id, name, color }
  if (Array.isArray(labels)) {
    return labels.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const e = entry as { id?: unknown; name?: unknown; label?: unknown; color?: unknown }
      const idRaw = e.id
      const id = typeof idRaw === 'number' ? idRaw : Number.parseInt(String(idRaw ?? '0'), 10)
      const labelStr = typeof e.label === 'string' ? e.label : typeof e.name === 'string' ? e.name : ''
      return [
        {
          id: Number.isFinite(id) ? id : 0,
          label: labelStr,
          color: typeof e.color === 'string' ? e.color : '',
        },
      ]
    })
  }

  return []
}

function isStringMap(v: unknown): v is Record<string, string | number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string' || typeof x === 'number')
}

/**
 * Collect up to N distinct sample values for a column id across items_page.
 * Used to give the heuristic / LLM a hint about what real data looks like
 * (e.g. status labels actually in use, or whether numbers are integer points
 * or float hours).
 */
function collectSampleValues(
  columnId: string,
  items: RawItem[],
  max: number,
): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const it of items) {
    const cv = it.column_values.find((c) => c.id === columnId)
    if (!cv) continue
    const raw = cv.value
    const key = raw ?? ' null'
    if (seen.has(key)) continue
    seen.add(key)
    let parsed: unknown = raw
    if (raw && raw.length > 0) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }
    }
    out.push(parsed)
    if (out.length >= max) break
  }
  return out
}

function rawColumnValuesToObject(values: RawColumnValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const v of values) {
    if (!v.value) {
      out[v.id] = null
      continue
    }
    try {
      out[v.id] = JSON.parse(v.value)
    } catch {
      out[v.id] = v.value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBoardDiscoveryService(
  client: MondayClient,
  options: DefaultBoardDiscoveryServiceOptions = {},
): BoardDiscoveryService {
  return new DefaultBoardDiscoveryService(client, options)
}
