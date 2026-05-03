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
import type { MondayClient } from './monday-client.js';
/**
 * Canonical column types we recognise for mapping. Monday's `type` field is
 * usually one of: 'color' (status), 'numeric', 'text', 'long-text', 'date',
 * 'people', 'multiple-person', 'tags', 'dropdown', 'formula', 'mirror',
 * 'link'. Anything else falls into 'other'.
 */
export type BoardColumnType = 'status' | 'text' | 'long-text' | 'date' | 'people' | 'dropdown' | 'numbers' | 'tags' | 'formula' | 'mirror' | 'link' | 'other';
export interface BoardColumn {
    column_id: string;
    title: string;
    type: BoardColumnType;
    /** Raw settings_str object (parsed) from Monday — opaque to callers. */
    settings: unknown;
    /** Top-N distinct sample values seen in items_page. Useful for hints. */
    sample_values: unknown[];
}
export interface BoardStatusLabel {
    id: number;
    label: string;
    color: string;
}
export interface BoardStatusColumn {
    column_id: string;
    labels: BoardStatusLabel[];
}
export interface BoardSampleItem {
    item_id: string;
    name: string;
    /** column_id → raw monday value object */
    columns: Record<string, unknown>;
}
export interface BoardWorkflowEdge {
    from_state: string;
    to_state: string;
    count: number;
    avg_dwell_ms: number;
}
export interface BoardSchema {
    board_id: string;
    /** Workspace id from Monday (may be empty if board not in workspace). */
    workspace_id: string;
    /** Display name of the board. */
    board_name: string;
    discovered_at: string;
    columns: BoardColumn[];
    /**
     * Convenience subset: every column with type='status', along with its
     * parsed labels. Mapping UI uses this directly.
     */
    status_columns: BoardStatusColumn[];
    has_subitems: boolean;
    /** Same shape as `columns` but for the subitem board. */
    subitem_columns?: BoardColumn[];
    /** First 5–10 items as sample data for the mapping LLM/heuristic. */
    sample_items: BoardSampleItem[];
    /**
     * Optional workflow history derived from item activity logs. Empty when not
     * supported or when the activity log API isn't available.
     */
    workflow_history: BoardWorkflowEdge[];
}
export interface BoardDiscoveryService {
    discover(boardId: string): Promise<BoardSchema>;
}
/**
 * MondayClient implementations that support introspection expose this method.
 * The default DefaultMondayClient does — see monday-client.ts.
 */
export interface MondayIntrospectClient extends MondayClient {
    graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
export interface DefaultBoardDiscoveryServiceOptions {
    /** Maximum sample value count per column. Default 5. */
    maxSampleValuesPerColumn?: number;
}
export declare class DefaultBoardDiscoveryService implements BoardDiscoveryService {
    private readonly client;
    private readonly maxSampleValuesPerColumn;
    constructor(client: MondayClient, options?: DefaultBoardDiscoveryServiceOptions);
    discover(boardId: string): Promise<BoardSchema>;
    private buildColumn;
}
/**
 * Map a raw Monday column type string to our BoardColumnType enum.
 *
 * Monday uses several aliases in the wild ('color' for what the docs call
 * 'status'; 'numbers' and 'numeric' both appear; 'long_text' vs 'long-text').
 * We normalise to a small canonical set.
 */
export declare function mapMondayTypeToCanonical(raw: string | null | undefined): BoardColumnType;
/**
 * Parse Monday's settings_str field. Monday returns the JSON as a string
 * (not pre-parsed), so we JSON.parse defensively. Returns an empty object on
 * parse failure so callers always see a record-like value.
 */
export declare function parseSettingsStr(s: string | null | undefined): unknown;
/**
 * Parse status-column settings into a flat label list.
 *
 * Monday's status settings shape (typical):
 *   { "labels": { "0": "Working on it", "1": "Done", ... },
 *     "labels_colors": { "0": { "color": "#fdab3d", ... }, ... } }
 * Some tenants expose `labels` as { id, name, color } objects; we tolerate
 * both forms.
 */
export declare function parseStatusLabels(settings: unknown): BoardStatusLabel[];
export declare function createBoardDiscoveryService(client: MondayClient, options?: DefaultBoardDiscoveryServiceOptions): BoardDiscoveryService;
//# sourceMappingURL=board-discovery.d.ts.map